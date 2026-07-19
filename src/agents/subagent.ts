// src/agents/subagent.ts
//
// Runs a specialist subagent for a specific SubTask.
// Each subagent:
//   - Has its own scoped task and context
//   - Has its own work subdirectory
//   - Saves output to a shared location for the aggregator
//   - Checks if it was the last sibling to complete → triggers aggregation
//
// Rollouts:
//   R2: tenant memory context prepended to system prompt + memory tools.
//   R3.1: SEO tool dispatch.
//   R3.1: bounded retries on the Anthropic API call with exponential backoff.
//   R3.1: hard iteration cap separate from config.AGENT_MAX_TURNS.
//
//   Structural hardening (12 May / 13 May):
//     - Captures baseline DB row counts at the top of runSubagent and
//       calls reconcileOutput before writing output.md. Reconciliation
//       prepends a hallucination warning if the model claimed writes
//       that didn't happen, and appends an authoritative "## Verified
//       DB writes" section.
//     - buildToolsForSpecialist now respects task_intent. 'investigate'
//       strips write-side SEO tools (propose_action, log_seo_action,
//       log_opportunity, snapshot_metrics, upsert_cluster).
//     - Investigate-mode safety net inside the tool dispatch loop: even
//       if a write-side SEO tool somehow leaked through, calls to it
//       are denied with a structured tool_result.
//     - buildSubagentSystem now intent-aware and explicit about the
//       anti-hallucination invariant.

import path from 'path'
import fs   from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import { config } from '../config'
import { AgentTask } from '../types'
import { TenantConfig } from '../tenants/types'
import { AGENT_TOOLS, executeTool } from './tools'
import { preToolUseHook } from '../hooks'
import { buildTenantSkillsPrompt } from '../skills/loader'
import { retrieveRelevant } from '../memory/vector'
import { startTrace, endTrace, recordUsage } from '../observability/langfuse'
import { createRunRecord, completeRunRecord } from '../memory/postgres'
import {
  getSubTask, startSubTask, completeSubTask, failSubTask,
  allSubtasksComplete, anySubtaskSucceeded, TaskIntent,
} from '../memory/subtasks'
import { enqueueAggregationJob } from '../queue/producer'
import { presenter }   from '../core/slack'
import { logger } from '../logger'
import { getMemoryContext, toPromptString } from '../memory/runtime'
import {
  MEMORY_TOOLS, executeMemoryTool, isMemoryToolName,
} from '../memory/tools'
import {
  SEO_TOOLS, executeSeoTool, isSeoToolName,
} from '../skills/seo'
import {
  ADS_SKILL_TOOLS, executeAdsSkillTool, isAdsSkillToolName,
  WRITE_SIDE_ADS_TOOL_NAMES, buildAdsOperatingPrinciplesPrompt,
} from '../skills/ads'
import {
  CRAWLER_TOOLS, executeCrawlerTool, isCrawlerToolName,
} from '../core/crawler'
import { cachedSystem, cachedTools } from '../lib/prompt-cache'
import { callAnthropic } from '../lib/anthropic-call'
import {
  buildIntegrationToolsForTenant,
  isIntegrationToolName,
  executeIntegrationTool,
} from '../integrations'
import {
  captureBaselineCounts, reconcileOutput, ReconciliationCounts,
} from './reconciliation'
import { budgetsFor } from './intent-budgets'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

// ── Iteration cap and retry policy ────────────────────────────────────────
const HARD_ITERATION_CAP = 15

// Phase 8.5: wall-clock + token enforcement per specialist run.
// Caps both runaway loops and unbounded research. Tenant.tokenBudgetPerRun
// is the soft ceiling per specialist; if it overruns we break out with a
// graceful summary rather than letting the loop continue burning credits.
// 2026-07-14: wall-clock is now INTENT-AWARE (budgets.wallClockMs from
// intent-budgets.ts). The old flat 8-minute cap clipped every autonomous
// daily generation run from 2 July onward before it could file its work.

// 2026-07-14: per-tool-call hard timeout. The wall-clock cap is only checked
// BETWEEN turns, so one tool call that never resolves (unbounded vendor poll,
// fetch without a timeout) freezes the run past every budget — observed live:
// specialists stuck 50+ min inside a single call. Any tool call exceeding the
// cap now returns an error string to the model (which adapts and moves on)
// instead of freezing the loop. The underlying promise may linger; the run
// does not.
const TOOL_CALL_TIMEOUT_MS = 5 * 60_000

async function toolCallWithTimeout(p: Promise<string>, toolName: string): Promise<string> {
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<string>(resolve => {
        timer = setTimeout(() => {
          logger.error('subagent_tool_call_timeout', { toolName, capMs: TOOL_CALL_TIMEOUT_MS })
          resolve(`TOOL_TIMEOUT: ${toolName} did not return within ${TOOL_CALL_TIMEOUT_MS / 60000} minutes. The vendor/API is hanging. Do NOT retry this exact call — work with what you have or use a different tool.`)
        }, TOOL_CALL_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    // Slow-tool observability (2026-07-14: runs burned 20min on ~10 tool
    // calls — 134s/call average — with no way to name the culprits).
    const ms = Date.now() - t0
    if (ms > 10_000) logger.warn('subagent_slow_tool_call', { toolName, ms })
  }
}

/** SEO tool names that mutate DB state. Stripped in investigate mode. */
const WRITE_SIDE_SEO_TOOL_NAMES = new Set([
  'propose_action',
  'log_seo_action',
  'log_opportunity',
  'snapshot_metrics',
  'upsert_cluster',
])

/**
 * All Anthropic calls go through the shared idle-timeout streaming wrapper.
 * Wall-clock per-call timeouts are gone: long healthy generations stream to
 * completion; only stream SILENCE (60s default) aborts and retries.
 */
async function callAnthropicWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  // Idle-timeout tuning (2026-07-19). The recurring subagent killer was
  // `IdleTimeoutError: anthropic stream idle for 60000ms` — it took out the
  // whole afternoon article run (3/3 subagents). Root cause: 60s idle was
  // too tight for heavy generation turns. A full article draft (thousands of
  // output tokens, often with extended thinking) can legitimately go quiet
  // for >60s between stream events when the API is under load — and because
  // a retry restarts the generation from scratch, all 3 attempts hit the
  // same wall at the same place and the subagent dies. 180s idle window +
  // 5 attempts gives long generations room to breathe while still killing a
  // genuinely dead connection (which stays silent indefinitely).
  return callAnthropic(anthropic, params, {
    label: 'subagent',
    idleTimeoutMs: 180_000,
    maxRetries: 5,
  })
}

// ── Tool builders ─────────────────────────────────────────────────────────

/**
 * Build the toolbelt for a specialist. Respects task_intent: if
 * 'investigate', strips write-side SEO tools so the model literally
 * cannot file approvals, log work, snapshot metrics, or upsert clusters
 * even if it tries.
 */
function buildToolsForSpecialist(opts: {
  tenantSkills: string[]
  tenant: TenantConfig
  taskIntent: TaskIntent
}): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [...AGENT_TOOLS, ...MEMORY_TOOLS]
  if (opts.tenantSkills.includes('seo')) {
    if (opts.taskIntent === 'investigate') {
      const readOnly = SEO_TOOLS.filter(t => !WRITE_SIDE_SEO_TOOL_NAMES.has(t.name))
      tools.push(...readOnly)
    } else {
      tools.push(...SEO_TOOLS)
    }
    tools.push(...CRAWLER_TOOLS)
  }
  if (opts.tenantSkills.includes('ads')) {
    if (opts.taskIntent === 'investigate') {
      tools.push(...ADS_SKILL_TOOLS.filter(t => !WRITE_SIDE_ADS_TOOL_NAMES.has(t.name)))
    } else {
      tools.push(...ADS_SKILL_TOOLS)
    }
  }
  tools.push(...buildIntegrationToolsForTenant(opts.tenant))
  return tools
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function runSubagent(task: AgentTask, subTaskId: string, tenant: TenantConfig): Promise<void> {
  const subTask = await getSubTask(subTaskId)
  if (!subTask) throw new Error(`SubTask ${subTaskId} not found`)

  const sessionId = uuid()
  const runId     = uuid()
  const taskIntent: TaskIntent = (subTask.task_intent ?? 'propose_changes') as TaskIntent

  // Each subagent gets its own subdirectory inside the parent task directory
  const workDir = path.resolve(config.PROGRESS_DIR, task.id, 'subagents', subTask.specialist_type)
  fs.mkdirSync(workDir, { recursive: true })

  logger.info('subagent_start', {
    tenantId:       task.tenantId,
    taskId:         task.id,
    subTaskId,
    specialistType: subTask.specialist_type,
    taskIntent,
  })

  await startSubTask(subTaskId)
  await createRunRecord({ id: runId, tenantId: task.tenantId, taskId: `${task.id}:${subTask.specialist_type}`, agentType: subTask.specialist_type, sessionId })
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: subTask.specialist_type, billingTag: tenant.billingTag, userId: task.slackUserId })

  await presenter.recordSpecialistStart(task.id, subTask.specialist_type)

  // Capture baseline DB row counts BEFORE the model loop. Reconciliation
  // uses (final - baseline) to derive what THIS run actually wrote.
  const reconciliationBaseline: ReconciliationCounts =
    await captureBaselineCounts(task.id, task.tenantId)

  const hookCtx = { taskId: task.id, sessionId, agentType: subTask.specialist_type, tenant, channelId: task.slackChannelId }
  const learnings = await retrieveRelevant({ tenantId: task.tenantId, agentType: subTask.specialist_type, query: subTask.task, topK: 3 })

  // Pull tenant memory (L2). Best-effort.
  let memoryPrompt = ''
  try {
    const ctx = await getMemoryContext({
      tenantId: task.tenantId,
      taskType: subTask.specialist_type,
      semanticQuery: subTask.task,
      tokenBudget: 1500,
    })
    memoryPrompt = toPromptString(ctx)
  } catch (err) {
    logger.warn('subagent_memory_load_failed', { subTaskId, err: String(err) })
  }

  const baseSystem = buildSubagentSystem(subTask, tenant, learnings, taskIntent)
  const system     = memoryPrompt ? `${memoryPrompt}\n\n${baseSystem}` : baseSystem
  const userMsg    = buildSubagentPrompt(subTask, workDir)

  const tools = buildToolsForSpecialist({
    tenantSkills: tenant.skills,
    tenant,
    taskIntent,
  })
  const memoryToolCtx = { tenantId: task.tenantId, runId: task.id }
  const seoToolCtx = {
    tenantId:      task.tenantId,
    runId:         task.id,
    taskId:        task.id,
    channelId:     task.slackChannelId,
    // Task 0.5.1: cron-fired tasks suppress individual Slack approval cards
    // and surface approvals via the final anchor report instead. Ad-hoc
    // tasks (slash command / mention / manual) post each approval directly
    // so the operator who's actively waiting sees them in real time.
    triggerSource: task.trigger,
  }

  // Task 0.5: log the actual toolbelt the agent receives. If the agent
  // later claims "DataForSEO tools unavailable" in its output, we can
  // grep these logs to verify whether the tools were missing from the
  // toolbelt (real wiring issue) or just hallucinated as unavailable
  // (prompt or training issue).
  logger.info('subagent_toolbelt', {
    tenantId: tenant.tenantId,
    taskId: task.id,
    subTaskId: subTask.id,
    taskIntent,
    toolCount: tools.length,
    toolNames: tools.map(t => t.name),
    tenantIntegrations: tenant.integrations,
  })

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }]
  let tokenCount = 0, toolCount = 0, finalOutput = ''

  // Per-intent budgets. daily_generation gets bigger caps because it
  // has to research multiple pillars + draft Framer content + file
  // approvals + snapshot in one specialist run; the old HARD_ITERATION_CAP
  // of 15 + max_tokens of 8096 caused this morning's cron to bail out
  // after a snapshot-only output.
  const budgets = budgetsFor(taskIntent)
  const iterationCap = Math.min(config.AGENT_MAX_TURNS ?? budgets.iterationCap, budgets.iterationCap)

  try {
    const startedAt = Date.now()
    let turns = 0
    let budgetExhausted: string | null = null
    while (turns < iterationCap) {
      turns++

      // Phase 8.5: wall-clock check (before API call so we don't burn one).
      // Intent-aware since 2026-07-14 — daily_generation gets 40min.
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > budgets.wallClockMs) {
        budgetExhausted = `wall-clock ${Math.round(elapsedMs / 1000)}s exceeded cap ${budgets.wallClockMs / 1000}s`
        logger.warn('subagent_budget_wall_clock', { taskId: task.id, subTaskId, elapsedMs, turns, capMs: budgets.wallClockMs })
        break
      }
      // Phase 8.5: token-budget check (tenant-configured ceiling)
      if (tenant.tokenBudgetPerRun && tokenCount >= tenant.tokenBudgetPerRun) {
        budgetExhausted = `token budget ${tokenCount}/${tenant.tokenBudgetPerRun} exceeded`
        logger.warn('subagent_budget_tokens', { taskId: task.id, subTaskId, tokenCount, budget: tenant.tokenBudgetPerRun, turns })
        break
      }

      const response = await callAnthropicWithRetry({
        model:      tenant.agentModel,
        max_tokens: budgets.maxTokens,
        system:     cachedSystem(system),
        tools:      cachedTools(tools),
        messages,
      })

      // Phase A: account for ALL four token usage fields, scaling cache_read at
      // 0.10x to match Anthropic's billing (cache hits cost 10% of normal input).
      // The previous code only summed input_tokens + output_tokens, which silently
      // ignored cache_creation and cache_read entirely — making it impossible to
      // tell if caching was working and giving us an undercount of real cost.
      const usage = response.usage
      const inputTokens     = usage?.input_tokens                ?? 0
      const cacheCreation   = usage?.cache_creation_input_tokens ?? 0
      const cacheRead       = usage?.cache_read_input_tokens     ?? 0
      const outputTokens    = usage?.output_tokens               ?? 0
      const billedThisTurn  = inputTokens + cacheCreation + Math.round(cacheRead * 0.10) + outputTokens
      tokenCount += billedThisTurn

      // Log per-turn breakdown so cache hit ratios are visible in Cloud Run logs.
      // Healthy caching pattern: cache_creation > 0 on turn 1, cache_read >> input on later turns.
      logger.info('subagent_tokens', {
        taskId:           task.id,
        subTaskId,
        turn:             turns,
        input_tokens:     inputTokens,
        cache_creation:   cacheCreation,
        cache_read:       cacheRead,
        output_tokens:    outputTokens,
        billed_this_turn: billedThisTurn,
        cumulative:       tokenCount,
        budget:           tenant.tokenBudgetPerRun,
      })

      if (response.stop_reason === 'end_turn') {
        finalOutput = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as Anthropic.TextBlock).text)
          .join('')
        break
      }

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
        const results: Anthropic.ToolResultBlockParam[] = []

        for (const tb of toolBlocks) {
          toolCount++
          logger.info('tool_call', {
            taskId: task.id, subTaskId, specialistType: subTask.specialist_type,
            toolName: tb.name, turn: turns,
          })

          // Investigate-mode safety net. The tool builder already strips
          // write-side SEO tools when taskIntent === 'investigate', so
          // this branch should only fire if there's a bug somewhere
          // upstream. Defence in depth.
          if (taskIntent === 'investigate' && WRITE_SIDE_SEO_TOOL_NAMES.has(tb.name)) {
            logger.warn('subagent_blocked_write_tool_in_investigate_mode', {
              subTaskId, taskId: task.id, toolName: tb.name,
            })
            results.push({
              type: 'tool_result',
              tool_use_id: tb.id,
              content: `Tool denied: this task is in 'investigate' mode and cannot perform writes. Return your findings as prose in output.md; do not attempt to file approvals or log work. The operator will decide next steps after reading your findings.`,
            })
            continue
          }

          // Memory tools (R2) — DB-only, no hook
          if (isMemoryToolName(tb.name)) {
            const output = await toolCallWithTimeout(executeMemoryTool(
              tb.name,
              tb.input as Record<string, unknown>,
              memoryToolCtx,
            ), tb.name)
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
            continue
          }

          // SEO tools (R3.1) — DB-only, no hook
          if (isSeoToolName(tb.name)) {
            const output = await toolCallWithTimeout(executeSeoTool(
              tb.name,
              tb.input as Record<string, unknown>,
              seoToolCtx,
            ), tb.name)
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
            continue
          }

          // Ads skill tools — propose_ads_action files HITL approvals;
          // query tool is read-only. Same ctx shape as the seo skill.
          if (isAdsSkillToolName(tb.name)) {
            const output = await toolCallWithTimeout(executeAdsSkillTool(
              tb.name,
              tb.input as Record<string, unknown>,
              seoToolCtx,
            ), tb.name)
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
            continue
          }

          // Crawler tools (SEO-1) — read-only inventory queries, no hook
          if (isCrawlerToolName(tb.name)) {
            const output = await toolCallWithTimeout(executeCrawlerTool(
              tb.name,
              tb.input as Record<string, unknown>,
              tenant,
            ), tb.name)
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
            continue
          }

          // Integration tools (Framer, GSC, GA4, DataForSEO) — external APIs.
          // All integration tools here are READ-only or otherwise safe; writes
          // are routed through propose_action → execution worker, not direct
          // tool calls. No HITL hook needed here.
          if (isIntegrationToolName(tb.name)) {
            const output = await toolCallWithTimeout(executeIntegrationTool(
              tb.name,
              tb.input as Record<string, unknown>,
              tenant,
            ), tb.name)
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
            continue
          }

          // Standard tools go through preToolUseHook (HITL gate)
          const event = { toolName: tb.name, toolInput: tb.input as Record<string,unknown>, toolUseId: tb.id, sessionId, taskId: task.id, tenantId: task.tenantId }
          const decision = await preToolUseHook(event, hookCtx)

          if (!decision.approved) {
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: `Tool denied: ${decision.reason}` })
            continue
          }

          const output = await toolCallWithTimeout(executeTool(tb.name, tb.input as Record<string,unknown>, workDir), tb.name)
          results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: results })
      }
    }

    if (budgetExhausted && !finalOutput) {
      finalOutput = `Run stopped early — ${budgetExhausted}. Partial work may be in run_scratchpad / approval_requests for review. No further proposals filed in this run.`
      logger.info('subagent_budget_stop_synthesised', { taskId: task.id, subTaskId, reason: budgetExhausted })
    }

    if (turns >= iterationCap && !finalOutput) {
      logger.warn('subagent_iteration_cap_hit', {
        taskId: task.id, subTaskId, specialistType: subTask.specialist_type,
        cap: iterationCap, toolCount, tokenCount,
      })

      try {
        const summaryMessages: Anthropic.MessageParam[] = [
          ...messages,
          {
            role: 'user',
            content:
              'You have used your iteration budget. STOP making tool calls. ' +
              "Based on what you've discovered so far, write 3-5 actionable findings " +
              'for the operator. Plain language. Lead with the action. Tell them the ' +
              "impact in their terms (don't use SEO jargon). If you don't have enough " +
              "data to make a confident finding, mark it explicitly: 'Looks like X but " +
              "I didn't have time to confirm.' " +
              'End with: SPECIALIST_COMPLETE: <one-line summary>',
          },
        ]

        const summaryResponse = await callAnthropicWithRetry({
          model:      tenant.agentModel,
          max_tokens: 2048,
          system:     cachedSystem(system),
          messages: summaryMessages,
        })

        // Phase A: same four-field accounting as the main loop.
        const sUsage          = summaryResponse.usage
        const sInputTokens    = sUsage?.input_tokens                ?? 0
        const sCacheCreation  = sUsage?.cache_creation_input_tokens ?? 0
        const sCacheRead      = sUsage?.cache_read_input_tokens     ?? 0
        const sOutputTokens   = sUsage?.output_tokens               ?? 0
        const sBilledThisTurn = sInputTokens + sCacheCreation + Math.round(sCacheRead * 0.10) + sOutputTokens
        tokenCount += sBilledThisTurn
        logger.info('subagent_tokens', {
          taskId:           task.id,
          subTaskId,
          turn:             'summary',
          input_tokens:     sInputTokens,
          cache_creation:   sCacheCreation,
          cache_read:       sCacheRead,
          output_tokens:    sOutputTokens,
          billed_this_turn: sBilledThisTurn,
          cumulative:       tokenCount,
        })

        finalOutput = summaryResponse.content
          .filter((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === 'text')
          .map((b: Anthropic.TextBlock) => b.text)
          .join('')

        if (!finalOutput) {
          finalOutput = `Specialist hit its work budget before completing the check. The findings below are partial.\n\nSPECIALIST_COMPLETE: Partial — hit work limit before finishing`
        }

        logger.info('subagent_cap_summary_complete', {
          taskId: task.id, subTaskId, summaryLen: finalOutput.length,
        })
      } catch (err) {
        logger.error('subagent_cap_summary_failed', {
          taskId: task.id, subTaskId, err: String(err).slice(0, 200),
        })
        const lastAsst = [...messages].reverse().find(m => m.role === 'assistant')
        if (lastAsst && Array.isArray(lastAsst.content)) {
          finalOutput = lastAsst.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('') ||
            `Specialist hit its work budget before completing the check. Partial findings only.\n\nSPECIALIST_COMPLETE: Partial — hit work limit before finishing`
        } else {
          finalOutput = `Specialist hit its work budget before completing the check.\n\nSPECIALIST_COMPLETE: Partial — hit work limit before finishing`
        }
      }
    }

    // ── Reconciliation ────────────────────────────────────────────────────
    //
    // Before we write output.md or hand off to the aggregator, compare
    // the agent's claims against the database. If it claimed writes
    // that never happened, prepend a hallucination warning. Always
    // append a "## Verified DB writes" section listing real rows so
    // the aggregator can use that as authoritative ground truth.
    const reconciled = await reconcileOutput({
      finalOutput,
      parentTaskId:   task.id,
      tenantId:       task.tenantId,
      subTaskId,
      specialistType: subTask.specialist_type,
      baseline:       reconciliationBaseline,
    })

    finalOutput = reconciled.reconciledOutput

    // Save output.md to disk for the aggregator
    const outputPath = path.resolve(workDir, 'output.md')
    fs.writeFileSync(outputPath, finalOutput, 'utf-8')

    // Extract summary from SESSION_COMPLETE marker if present
    const marker  = finalOutput.match(/SPECIALIST_COMPLETE:\s*(.+)/m)
    const summary = marker?.[1]?.trim() ?? finalOutput.slice(0, 200)

    recordUsage(sessionId, tenant.agentModel, tokenCount, 0)

    await completeSubTask({ subTaskId, output: finalOutput, summary, tokenCount, toolCallCount: toolCount })
    await completeRunRecord({ id: runId, status: 'completed', tokenCount, toolCallCount: toolCount, summary })
    await presenter.recordSpecialistComplete(task.id, subTask.specialist_type, summary, tokenCount)
    await endTrace(sessionId, 'success', summary)

    logger.info('subagent_complete', {
      tenantId:       task.tenantId,
      taskId:         task.id,
      subTaskId,
      specialistType: subTask.specialist_type,
      tokenCount,
      turns,
      taskIntent,
      reconciliationMismatch: reconciled.mismatch,
      verifiedWrites: reconciled.delta,
    })

    const allDone  = await allSubtasksComplete(task.id)
    const anyGood  = await anySubtaskSucceeded(task.id)

    if (allDone && anyGood) {
      logger.info('all_subagents_complete_triggering_aggregation', { taskId: task.id })
      await enqueueAggregationJob(task)
    }
  } catch (err) {
    logger.error('subagent_failed', { subTaskId, err: String(err) })
    await failSubTask(subTaskId, String(err))
    await completeRunRecord({ id: runId, status: 'failed', tokenCount, toolCallCount: toolCount, error: String(err) })
    await presenter.recordSpecialistFailure(task.id, subTask.specialist_type, String(err).slice(0, 400))
    await endTrace(sessionId, 'error')
    throw err
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSubagentSystem(
  subTask: Awaited<ReturnType<typeof getSubTask>> & {},
  tenant: TenantConfig,
  learnings: Array<{ content: string }>,
  taskIntent: TaskIntent,
): string {
  const skillsPrompt = buildTenantSkillsPrompt(subTask.skills)
  const learningsSection = learnings.length
    ? `## Relevant past learnings\n${learnings.map(l => `- ${l.content}`).join('\n')}\n`
    : ''

  const hasSeoSkill = (subTask.skills ?? []).includes('seo') || tenant.skills.includes('seo')
  const hasAdsSkill = (subTask.skills ?? []).includes('ads') || tenant.skills.includes('ads')

  // CMS-aware tool naming: one tenant has exactly one CMS. The daily
  // generation playbook below references CMS tools by name; Webflow tenants
  // get the webflow_* set, everyone else the framer_* set.
  const isWebflowCms = Array.isArray(tenant.integrations) && tenant.integrations.includes('webflow')
  const cmsName      = isWebflowCms ? 'Webflow' : 'Framer'
  const cmsListTool  = isWebflowCms ? 'webflow_list_blog_items' : 'framer_list_blog_items'
  const cmsPrefix    = tenant.cmsPathPrefixes?.[0] ?? '/resources/'
  const cmsDomain    = tenant.targetDomain ?? 'the production site'
  const cmsMetaTool  = isWebflowCms ? 'webflow_update_blog_meta' : 'framer_update_blog_meta'
  const cmsBodyTool  = isWebflowCms ? 'webflow_update_blog_body' : 'framer_update_blog_body'
  const cmsAltTool   = isWebflowCms ? 'webflow_add_blog_alt_text' : 'framer_add_blog_alt_text'
  const cmsLinkTool  = isWebflowCms ? 'webflow_add_internal_link' : 'framer_add_internal_link'
  const cmsPageText  = isWebflowCms ? 'webflow_update_marketing_page_text' : 'framer_update_marketing_page_text'

  // Intent-aware tool guidance. Investigate-mode specialists are told
  // explicitly that the write-side SEO tools have been stripped, and that
  // their job is to return findings as prose. Propose-changes-mode
  // specialists get the integration-tools-first + propose_action-as-only-
  // write-path guidance (the prompt patch authored 12 May).
  const intentSection = taskIntent === 'investigate'
    ? `# Task mode: INVESTIGATE (read-only)

This task is in INVESTIGATE mode. The operator wants to UNDERSTAND something — they have not asked for changes. Your write-side SEO tools have been stripped from your toolbelt. You cannot:
  - File approval requests (propose_action is unavailable)
  - Log work to seo_work_log
  - Record opportunities to seo_opportunities
  - Snapshot metrics
  - Update cluster state

You CAN:
  - Use integration tools (analyze_page, framer_*, gsc_*, ga4_*, dataforseo_*) to GATHER information
  - Use query_* tools to read existing opportunities, clusters, recent actions
  - Use memory tools (record_memory, query_memory, scratchpad_*)
  - Use standard tools (read_file, write_file in your workdir, list_directory, run_command, web_search, web_fetch)

Your output is FINDINGS, not actions. If you notice something the operator might want to act on, surface it as a finding ("The homepage title is over 60 characters and may be truncating in search results") — do NOT try to file approvals. The operator will decide what to do.
`
    : taskIntent === 'weekly_audit'
    ? `# Task mode: WEEKLY AUDIT (strategic state-of-play)

You're producing the weekly briefing for ${tenant.clientName}'s operator. They want to know what happened, what it means, and what to do next — not a list of metrics.

## Structure your output around four sections

**0. What we shipped 30 days ago — did it work?** Query seo_work_log for entries created 28-35 days ago. For each, look at the target page's current metrics (rankings, indexed status, traffic) vs the metrics around the time we shipped. Compute the delta. This is the agent's learning loop — record findings as memories (record_memory with type='learning' and key prefix 'retro-', e.g. key='retro-title-rewrites-services-Apr2026') so future runs can learn from past wins and misses.

  - Wins worth noting: position improved by ≥3 spots, traffic up ≥20%, newly indexed
  - Misses worth noting: position dropped or stayed flat, no traffic movement, deindexed

  Surface the top 2-3 retrospective signals in the briefing. Don't list every change.

**1. What happened this week.** Pull from approval_requests (approved/rejected counts), seo_work_log (what shipped), and seo_metrics_snapshots (deltas across the week). Name specific pages and specific changes. Skip the table; tell the story.

**2. What it means strategically.** Are ${tenant.clientName}'s rankings, indexed pages, traffic, or competitive position improving, holding, or eroding? Compare against last week and against competitors where you have the data. Flag risks plainly — don't bury them.

  Architectural lens (every week, even briefly): read seo_clusters. For each top 3 cluster by importance, check whether competitors have stronger pillar coverage. Use dataforseo_keywords_for_site on each competitor + web_fetch on their sitemap to see the shape of their topic coverage. If a competitor has 8 supporting pages under a cluster where we have 2, that's an architectural gap — surface it.

**3. Top 3 leverage moves for next week.** Specific enough that the operator can say yes or no to each. Each one needs a clear "what" and a clear "why now." Don't propose action via propose_action this run — log them as seo_opportunities (priority: P1) so they show up in the operator's pipeline. The daily generation cron will pick them up next morning and turn them into concrete drafts.

## Tone

This is a briefing for a smart business owner, not an SEO report. Same writing rules as elsewhere — plain English, no jargon without context, lead with what the operator gains.

If the week was quiet (no shipped work, no rankings movement, nothing competitive), say so plainly in one sentence. Don't pad. The operator trusts honest summaries more than padded ones.

## What you have

Use query_recent_actions, query_opportunities, snapshot_metrics (read recent rows), DataForSEO for competitor context, Framer for current state, record_memory for retrospective findings. The integration toolbelt is logged at run start so you can confirm what's available.
`
    : taskIntent === 'weekly_digest'
    ? `# Task mode: END-OF-WEEK DIGEST (celebration / momentum recap)

It's Friday afternoon. You're writing a short, shareable recap of this week's work for ${tenant.clientName}'s operator. Think of it as something they could forward to a colleague or their team.

## Structure

**Lead with what shipped.** Name the changes plainly — what page, what changed, in customer-facing language. Avoid SEO jargon. If three things shipped, say "We did three things this week:" then list them. If one thing shipped, say so. If nothing shipped, just say so honestly.

**Surface 1-2 numbers that show momentum.** Pick the most meaningful: rankings climbed for keyword X, indexed pages went from N to M, traffic up Y%, whatever's actually moved this week. Don't list every metric. One or two real signals.

**Close with a one-line outlook.** "Next week, focus is on X" — pull this from the seo_opportunities queue or recent propose_actions. Brief.

## Tone

Celebratory but honest. The operator will know if the week was actually good or not — don't manufacture wins. A short honest digest ("quiet week — focused on research, expecting movement next week") is better than a padded one.

Plain English throughout. Same writing rules as elsewhere — write like a thoughtful colleague reporting to a business owner.

## What you have

Use query_recent_actions for what shipped, query_opportunities for next week's pipeline, snapshot_metrics (read recent rows) for the numbers. Keep the scope tight — this is a digest, not an audit.
`
    : taskIntent === 'daily_generation'
    ? `# Task mode: DAILY GENERATION

This task is the morning cron run. Your job: produce real work for ${tenant.clientName}'s team. ${tenant.autonomyLevel === 'full'
  ? `This tenant runs AUTONOMOUSLY: propose_action calls for API-executable tools are auto-approved and execute within minutes — there is no human review between you and the live site. That raises the bar, it does not lower it: every change must be grounded in data you actually read this run.`
  : `They should wake up to a short queue of specific things to decide about, plus a few leads for the backlog.`}

## What good looks like

By end of run, you've produced:
  - **${tenant.autonomyLevel === 'full' ? '8-12' : '2-5'} propose_action calls.** Each one is a concrete change you've already drafted (not a vague recommendation). ${tenant.autonomyLevel === 'full'
    ? `These execute automatically — treat each one as if you were pressing the publish button yourself. Never file a change to a page you have not read this run, and never redo or reverse work from the last 7 days (check approval_requests + seo_work_log first). Grounded-only still applies — an adversarial critic reviews every filing and rejects anything ungrounded, off-lane, or risky — but do NOT stop at 3-4 actions when the opportunity bank has more: an under-filed run leaves ranked-and-scored work sitting in the bank doing nothing.

ACTION MIX (aggressive on the compounding levers): aim per run for AT LEAST 3 meta title/description rewrites, 3 internal links, and 1 body-copy strengthening of an existing page (pull from the copy_optimise entries in the bank — the detail JSON includes secondary_gap_keywords to weave in), PLUS the one article. The bank's metadata_edit / copy_optimise / internal_link entries were scored and ranked overnight — DRAFT from them instead of rediscovering. Alt-text fixes no longer count toward the mix: the backlog is nearly exhausted; file them only when you touch a page anyway.`
    : 'The Slack approval card shows the operator a preview URL they can click and review before approving.'} The wording is plain English, not SEO jargon.
  - **3-5 seo_opportunities entries.** Each is a specific lead, target, or insight worth pursuing later — not a generic recommendation like "improve meta descriptions."
  - **One snapshot_metrics call** at some point in the run, so we have continuity for tomorrow's comparison.

A run that produces zero approvals AND zero opportunities is a failed run, not a quiet day. Flag it explicitly in your output.md so the operator knows to investigate.

## Where to look for work

Article creation is the **primary growth lever** for this tenant. Draft EXACTLY ONE blog post per run — pick the strongest topic gap and execute it well. Do NOT attempt 2 or more blog posts in a single run; the token budget will not support it and the run will hang at synthesis. The other categories below are real work, but they are secondary — they harden what already exists. New articles are how we expand surface area and rankings into clusters we don't currently own.

**New blog posts — primary focus.** What is ${tenant.clientName} not writing about, that competitors are? Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial intent. File the post via propose_action with toolName='approve_blog_pitch' (two-stage flow — full playbook below). For NEW LANDING PAGES (not blog posts), the ${cmsName} API can't create them programmatically — propose_action with toolName='manual_operator_task' instead, giving the operator the page outline + a list of pages to add to nav etc.

**Internal links between existing blog posts.** Two posts that obviously belong linked but aren't → propose_action with toolName='${cmsLinkTool}', toolInput={ slug, sourceText, targetUrl }. sourceText must be the exact verbatim text on the page. Internal links on non-blog marketing pages → manual_operator_task.

**Copy or meta on existing pages.** Blog meta → '${cmsMetaTool}' ({ slug, newTitle?, newDescription? }). Blog body additions/refreshes → '${cmsBodyTool}' ({ slug, newContent }). Marketing page body text → '${cmsPageText}' ({ pagePath, oldText, newText }).${isWebflowCms ? ` Marketing/service page META (title/description) is API-writable on Webflow → 'webflow_update_page_meta' ({ pagePath, newTitle?, newDescription? }) — do NOT file these as manual tasks.` : ` Marketing page meta is NOT API-writable on Framer → manual_operator_task with precise UI instructions.`}

**Backlink leads from competitor analysis.** Use dataforseo_backlinks_summary to find domains linking to competitors but not to ${tenant.clientName}. These go to seo_opportunities (log_opportunity) — backlinks need human outreach, not a click-to-approve.

When you log a backlink opportunity, include a short draft outreach pitch in the body. The operator should be able to copy-paste it and personalise the first sentence before sending. Plain English, friendly tone, lead with what's in it for THEM (the domain owner) rather than what we want. Skeleton:

  Subject: [3-6 word hook tied to their published work]
  Body: "Hi [their name], I just read your piece on [topic]. We're working on [our angle] over at ${tenant.clientName} and noticed [specific signal that shows you actually read their stuff]. [One short line of how a link/mention helps THEIR readers]. No worries either way — happy to chat if useful. [your name]"

Don't be slick. Mention specifically what their piece said. If you can't tell what their piece is about from the data, don't draft a pitch — just log the lead with "needs research before outreach" and let the operator decide.

${(tenant.competitorDomains && tenant.competitorDomains.length > 0)
  ? `Known competitor domains for ${tenant.clientName}: ${tenant.competitorDomains.join(', ')}. Use these as the seed list.`
  : `No competitor list configured for ${tenant.clientName} yet. Call dataforseo_competitor_research with target='${tenant.clientName.toLowerCase()}.au' (or the tenant's primary domain) to discover 5-10 strong competitors, then proceed using the top 3 by intersection count.`}

## Writing style (important — this is the customer-facing voice)

The operator is a smart business owner, not an SEO consultant. They use Slack on their phone between client calls. Cards should be readable in five seconds.

When you write the **proposedAction** for a propose_action call:

- Lead with what the user gains or what changes on their site. Not what the agent is doing.
- Plain English. Avoid SEO jargon unless you also explain it in context (or skip the jargon and describe the impact).
- Don't narrate your own mechanics. Don't say "I'll propose this for approval" or "publish to preview so it goes live once you approve" — the Slack card and approval flow are obvious from context.
- Specific, not generic. "Add an FAQ section about pricing on the homepage" beats "Improve homepage content."
- In article bodies: bold the exact target keyword AT MOST once. Repeated bolded exact-match phrases ("**level 2 asp electrical**" eight times) read robotic, hurt trust, and flag over-optimization. Use natural variants; format for the reader.
- CONTACT DETAILS ARE FACTS, NOT COPY. Never write a phone number, email, or address in article content unless it exactly matches a verified tenant memory fact (e.g. 'contact-phone'). If no verified contact detail exists, omit it and link to the contact page instead. Invented phone numbers have shipped to live client sites — validation now rejects any unverified number.

Examples:

  BAD: "/home-2 is a leftover staging page showing up to search engines — set it to noindex so Google ignores it. Propose the change for approval and include publish to preview so it goes live once I approve."
  GOOD: "There's a duplicate of your homepage at /home-2 that's confusing Google. Hide it from search results."

  BAD: "Add schema.org Organization markup to /about for better SERP visibility"
  GOOD: "Add a structured-data block to /about so your business name, location, and phone show up properly in Google search results."

  BAD: "Optimize canonicals on /pricing"
  GOOD: "Fix a duplicate-page signal on /pricing so Google ranks the right version."

  BAD: "Trim homepage title from 87 to 52 chars"
  GOOD: "Shorten the homepage title so it stops getting cut off in Google results."

For **log_opportunity** entries, same style — but you have a bit more room to explain context since these are for the backlog rather than the approval queue.

## What you have to work with

Your toolbelt includes ${cmsName} (read + draft creation), DataForSEO (keywords, competitors, backlinks), Google Search Console, GA4, and the standard analyze_page tool. If something you need seems missing, call the integration tools first to verify rather than assuming unavailable — the toolbelt at run start is logged so you can be confident about what you have.

Before filing a propose_action or log_opportunity, quickly check approval_requests and seo_opportunities for the last 7 days to avoid surfacing the same thing twice.

**Learn from measured outcomes (highest-authority signal).** Call query_memory with type='win' and type='loss' early in the run. Keys prefixed 'outcome-' are MEASURED results: GSC clicks/position deltas for the exact page each past action targeted, compared against the rest of the site as a control. These are ground truth, not opinion — weight them above every other prior. Do more of the action types and page types that won; stop proposing the ones that lost. If title rewrites keep winning and schema additions keep landing neutral, your action mix this run should reflect that.

**Learn from past runs.** Call query_memory with type='learning' early in the run — the weekly audit writes retrospective findings here (keys prefixed 'retro-') about what kinds of changes have actually moved the needle for ${tenant.clientName} in the past. If past data shows (for example) that title-rewrites for /service-pages moved rankings 3+ spots, lean into more of that. If it shows that schema additions did nothing, deprioritise those. The retrospective memories are how the agent gets smarter over time — don't ignore them.

## On ${cmsName} blog posts (research-first, two-stage approval)

Two operator-facing gates: PITCH (you propose; operator says is-this-worth-writing?) then PUBLISH (operator reviews the actual draft in ${cmsName}; says ship-it?). Both are propose_action calls — you only ever file one card per post. The second card is created by the executor on the operator's first approval.

CRITICAL: BEFORE proposing anything, ground the topic in ${tenant.clientName.toUpperCase()}'S actual performance data. A "content gap" is not an opportunity by itself — a topic that has search demand AND fits ${tenant.clientName}'s commercial model AND is adjacent to content that's already working IS. Skipping the grounding step produces off-brand topics that waste the operator's time.

Workflow:

### Phase A — Ground in ${tenant.clientName}'s actual performance

A.1  Call query_memory with type='learning' early. Look for retro-* keys — past runs have written findings about what kinds of work moved the needle for this tenant. Use these as priors.

A.2  Call gsc_query_search_analytics with last 28 days, dimensions=['page', 'query'], rowLimit=200. Identify:
     - The top 5 pages by clicks (what content is already winning)
     - Top 20 queries by impressions where position is 4-15 (rankings within striking distance to improve)
     - Themes across high-impression queries (what topics is the audience actually searching for)

A.3  Call ${cmsListTool}. Read the titles + dates. Map each one onto a theme: which topics on the site already have proven traction (from A.2), which were written but didn't pull traffic, what's the editorial range.

A.4  Form a hypothesis: what topic, IF added to the site, would (a) build on a proven theme from A.2 rather than start a new one, (b) match the existing site's evident commercial lane (look at what existing posts SELL — who would click an outbound CTA?), and (c) target a query cluster with real intent.

A.4b If Ahrefs tools are in your toolbelt, sharpen the hypothesis before validating: ahrefs_organic_competitors on our domain to confirm who actually competes for our queries (often different from the configured list), then ahrefs_organic_keywords on the top 1-2 competitors to see which of their ranking keywords we have no page for. A topic gap confirmed by competitor rankings beats one inferred from volume data alone. These calls are cached — use them.

A.5  Validate the hypothesis with dataforseo_keyword_data on 3-5 candidate queries around your topic. You're looking for: AU search volume ≥ 50/month, CPC ≥ $2 (signals commercial intent), keyword difficulty ≤ 60. If your candidate fails all three, pick a different angle.

If A.1–A.5 produces no candidate that passes, STOP and surface the situation to the operator rather than picking a weak topic. A blog post written for nobody is worse than no post.

### Phase B — Write the post (only after A passes)

${isWebflowCms
  ? `B.1  (Webflow: no pending-changes check needed — CMS item publishes are item-scoped and do not bundle unrelated site changes.)`
  : `B.1  Call framer_get_changed_paths. If pending changes exist, STOP — surface to operator. Publishing would bundle them.`}

B.1b Ground the draft in what actually ranks BEFORE writing a word (if Surfer tools are in your toolbelt):
     - Call surfer_content_guidelines with the validated keyword from A.5. Extract the prominent terms, target word-count range, and heading structure. Write the draft AGAINST these from the first pass — the publish gate scores against the same Surfer editor, so drafting blind means discards and wasted runs.
     - Look at the top 2-3 ranking pages for the keyword (ahrefs_serp_overview if available — it includes DR and traffic per result — else dataforseo SERP data, or analyze_page on their URLs). Note the intent they serve, their depth, and what they miss — your post must match the intent and beat the depth or the angle, not just exist.

B.2  Re-read the 2-3 highest-traffic posts from A.2. They ARE the voice and structure you mirror. Cadence, paragraph length, register, how subheads work, whether posts close with a CTA or a thought. Do not invent a new tone.

B.3  Write the post in full — title + slug + content. ${isWebflowCms
  ? `Content is standard rich-text HTML for Webflow's body field: <p>, <h2>, <h3>, <strong>, <ul>, <li>, <a>.`
  : `Content is HTML in Framer's formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>.`} Headline should map to the validated query cluster from A.5. LENGTH IS NON-NEGOTIABLE: write to the word-count target from the B.1b guidelines (server-side validation enforces ~80% of the minimum, and the publish gate scores against the same SERP — a 700-word draft against a 2,000-word SERP scores ~15/100 and gets discarded no matter how well written). Hit the target with genuine depth: concrete costs, timelines, step-by-steps, FAQs — never filler.

B.4  Embed 2-4 internal links where the cross-reference is genuinely useful (not gratuitous). Mix TWO target types: other blog posts (<a href="${cmsPrefix}SLUG">…</a>, slugs from ${cmsListTool}) AND the site's deep SERVICE pages when the sentence mentions that service (e.g. a sentence about switchboard work links to the switchboard-upgrades service page — find real paths via ${isWebflowCms ? 'webflow_list_pages' : 'the crawled page inventory'}). NEVER link to the bare homepage from body copy — deep pages only. Anchor text is a real noun phrase from the sentence. Prefer high-traffic targets from A.2 (they're already ranking; pass authority).

B.5  Call pexels_search with a 2-4 word CONCRETE-NOUN query that reflects the post subject. Avoid abstract phrases. Pick the most editorially-relevant result. Use the "url_for_post" field — landscape-cropped URL ready for the CMS.

### Phase C — File the pitch

HARD REQUIREMENTS BEFORE FILING (server-side validated — your pitch will be REJECTED with an error if any of these are missing):

1. toolInput.imageUrl MUST be a non-empty URL. If you have not called pexels_search yet, do it NOW (step B.5). Without a hero image the published page renders broken. NOT optional.

2. toolInput.content MUST contain at least 2 internal links in the form <a href="${cmsPrefix}SLUG">anchor text</a>. Use slugs from ${cmsListTool}. Anchor text must be a real noun phrase (not 'click here', not the bare title). NOT optional.

If you file without these, the system returns PITCH_VALIDATION_FAILED and you have to redo the work. Treat them as preconditions, not nice-to-haves. The operator sees a broken page if you skip them; the validation exists to protect them.

C.1  File propose_action ONCE with:
     toolName       = "approve_blog_pitch"
     toolInput      = { slug, title, content, imageUrl, whyThisTopic, targetKeyword, metaTitle, metaDescription }
     (targetKeyword = the validated primary query from A.5 — it drives the Surfer content score AND the cannibalization check, so pass the real keyword, not the title)
     (metaTitle = 30-70 char SEO title; metaDescription = 70-160 char compelling summary — BOTH REQUIRED, server-validated. They render in Google results AND as the blog listing card, so write them as ad copy for the click, not as an afterthought.)
     proposedAction = one-line plain-English pitch summary for the operator
     priority       = P0 / P1 / P2 / P3
     previewUrl     = https://${cmsDomain}${cmsPrefix}<slug> (will 404 until Stage 2 approve)
     whyPriority    = grounding from Phase A — cite the GSC signal (e.g. "/<existing-page> ranks position 8 for [query] with 1,200 monthly impressions; this new post targets the upstream intent")

C.2  What happens after:${tenant.autonomyLevel === 'full' ? `
     AUTONOMOUS tenant: Stage 1 auto-approves immediately. The executor runs the Surfer quality pipeline (AI-detect → humanize + fact re-verify → content score → one revision pass). Score at/above threshold → Stage 2 auto-approves and the post publishes to the live site. Below threshold or Surfer unavailable → the article is DISCARDED (a 'publish-failed-{slug}' loss memory is written; no draft, no human review). Check query_memory for publish-failed-* entries before picking a topic — a discarded slug means that draft failed the gate; retry with a substantially different angle or a different topic, not the same content. Your draft quality decides whether the post ships in minutes or is thrown away — write it to pass.` : `
     - Stage 1 approve: executor creates ${cmsName} draft + posts Stage 2 card in the same thread.
     - Stage 1 reject: nothing created. No cleanup.
     - Stage 2 approve: publishes live to ${cmsDomain}. Operator reviews the rendered draft in ${cmsName} between Stage 1 and Stage 2.
     - Stage 2 reject: rollback removes the draft.`}

Critical: do NOT try to create CMS drafts yourself with read tools, and do NOT use toolName 'framer_create_and_publish_blog_post' (deprecated). The draft creation happens server-side after Stage 1 approve — you only file the pitch.

For non-blog work, pick the right tool from the taxonomy above. Quick reference: marketing page body text → ${cmsPageText}; blog meta → ${cmsMetaTool}; blog body → ${cmsBodyTool}; blog alt text → ${cmsAltTool}; blog internal links → ${cmsLinkTool}${isWebflowCms
  ? `; marketing/service page meta → webflow_update_page_meta (API-writable on Webflow — never a manual task)`
  : `; site-wide JSON-LD schema → framer_add_site_schema`}. ONLY use manual_operator_task when no API tool above applies: ${isWebflowCms
  ? `robots.txt edits, sitemap.xml direct edits, per-page canonicals or noindex toggles, site-wide custom code/schema, new marketing pages (design brief)`
  : `marketing-page meta titles/descriptions, robots.txt edits, sitemap.xml direct edits, per-page canonicals or noindex toggles, new marketing pages (design brief), or internal links on marketing pages`}. When you DO use manual_operator_task, the instruction field must be precise enough that the operator can complete the task in ${cmsName}'s editor without further input from you.
`
    : `# Task mode: PROPOSE CHANGES (can file approvals)

This task is in PROPOSE_CHANGES mode. The operator has asked for action. You have your full toolbelt including write-side SEO tools.

## Integration tools FIRST, propose_action as the ONLY write path

When you need to LOOK AT external systems (Framer, Google Search Console, GA4, DataForSEO, the live website), use the integration tools FIRST. Do not propose changes to a page you haven't read; do not claim something about rankings you haven't checked.

WRONG (don't do this):
  - Call propose_action to "fix the homepage title" without calling framer_get_page or analyze_page first
  - Claim "the homepage is hidden from Google" without calling gsc_inspect_url or web_fetch
  - Recommend a schema fix without calling analyze_page to see what schema currently exists

RIGHT (do this):
  - analyze_page(https://${tenant.clientName}.au/) → see actual title, meta, schema, alt coverage
  - Then propose_action(toolName=..., toolInput=..., proposedAction="Shorten the homepage title so it stops getting cut off in Google results", whyPriority="Currently truncating mid-word; lower click-through rate")

## propose_action is the ONLY way to write a change for the operator

If you want the operator to do something (publish, edit, fix, change a setting on a tenant system), you call propose_action. That writes a row to approval_requests. The operator sees it in Slack and either approves (the executor worker then applies the change via the appropriate integration tool) or rejects.

## Writing the proposedAction text

The proposedAction is what the operator sees in Slack. Write it for a smart business owner reading their phone between client calls. Plain English, customer-facing voice. Lead with what changes or what they gain, not with what the agent is doing.

  BAD: "Set noindex on /home-2 so Google ignores it. Propose for approval with publish to preview."
  GOOD: "There's a duplicate of your homepage at /home-2 that's confusing Google. Hide it from search results."

  BAD: "Add schema.org Organization markup to /about for SERP visibility."
  GOOD: "Add a structured-data block to /about so your business name, location, and phone show up properly in search results."

Don't narrate the approval flow ("propose for approval", "publish to preview", "once you approve") — the Slack card and buttons make that obvious.

You do NOT:
  - Apply changes directly via integration tools (framer_update_*, gsc_submit_*, etc.) — those are reserved for the executor worker, post-approval
  - Use log_seo_action to record "shipped" work the operator hasn't approved
  - Use snapshot_metrics or upsert_cluster as a substitute for propose_action

If the change is small and reversible (e.g. a memory/note for yourself), the memory tools and scratchpad are fine. Anything that touches the tenant's actual website or external accounts goes through propose_action.
`

  const seoLoggingHint = hasSeoSkill && (
       taskIntent === 'propose_changes'
    || taskIntent === 'daily_generation'
    || taskIntent === 'weekly_audit'
    || taskIntent === 'weekly_digest'
  )
    ? `\nYou have SEO logging tools. When you ship work (post-approval, via the executor), find an opportunity, or measure a metric, write it to the database so the aggregator can build daily/weekly reports:
- log_seo_action: record completed actions (anything shipped, deployed, published) → seo_work_log
- log_opportunity: surface a finding worth doing later → seo_opportunities
- snapshot_metrics: snapshot a metric (rankings, indexed pages, CWV) → seo_metrics_snapshots
- upsert_cluster: update topical cluster state → seo_clusters
Use these aggressively. Anything not written to the DB doesn't appear in daily/weekly reports.\n`
    : ''

  const adsPrinciplesBlock = hasAdsSkill ? `\n${buildAdsOperatingPrinciplesPrompt()}\n` : ''

  const businessBriefBlock = tenant.businessBrief
    ? `\n# About ${tenant.clientName} — businessBrief — authoritative, do not infer otherwise\n${tenant.businessBrief}\n`
    : ''
  return `You are the ${subTask.specialist_name} for ${tenant.clientName}, an agent built by Causal Growth Science.
${businessBriefBlock}

# Who you're writing for

The person reading your output is ${tenant.clientName}'s operator — they run the business, not an SEO agency. They don't know what "SERP", "CTR", "topical authority", "canonical tag", "H1", "meta description", "schema markup", "crawler", or "anchor text" means. They DO know whether their customers are finding them, whether their website looks broken, and whether their phone is ringing.

Write every finding for THAT person. If a sentence requires SEO knowledge to understand, rewrite it.

# Jargon translation

Never use these terms as-is. Replace them — or define them inline on first use — every time:

| Don't say | Say instead |
|---|---|
| SERP, search engine results page | "search results" |
| CTR, click-through rate | "how often people click your listing in search results" |
| topical authority | "Google's understanding of what your business is about" |
| canonical tag, canonical URL | "the 'official' version of a page that Google should rank" |
| crawler, bot, spider | "Google's discovery tools" |
| H1, H1 tag | "the main headline on the page" |
| H2, H3 | "section headings" |
| meta description | "the summary that shows under your page title in search results" |
| meta title, page title, title tag | "the headline shown in search results" |
| schema markup, structured data, JSON-LD | "behind-the-scenes labels that help Google understand the page" |
| robots.txt | "the file that tells Google which pages to ignore" |
| sitemap | "the map of your website Google reads to find pages" |
| keyword dilution | "Google getting confused about what the page is about" |
| keyword cannibalisation | "two of your pages competing for the same search term" |
| internal links | "links between pages on your own site" |
| backlinks | "links pointing to your site from other websites" |
| anchor text | "the words used in a link" |
| Core Web Vitals, LCP, CLS, FID | "how fast your pages load" |
| indexed, indexing | "shown by Google" / "appearing in search results" |
| de-indexed, noindex | "hidden from Google" |

If you find yourself reaching for a term not on this list and it's industry-specific, define it the same way.

${intentSection}
${adsPrinciplesBlock}
# Match depth to scope

Read the request shape and infer scope BEFORE you start working.

- "quick check", "have a look", "is anything wrong", "anything broken", short questions → 1-3 tool calls, 3-5 findings max. Stop early.
- "audit", "full review", "comprehensive check", "deep dive" → broader, 5-10 tool calls, fuller coverage.
- "why isn't X happening" / "help me with Y" / "fix Z" → diagnostic. Scope only to that question. Don't sprawl.
- Anything vague or short → default to quick-check scope. Operators usually want fast wins, not full reports.

# Stop discipline

After every tool call, ask yourself: "Do I have enough to give the operator 3-5 useful findings?"

- If YES → STOP and write output.md. Don't keep checking just because you can.
- If you've made 8+ tool calls without a clear answer → stop and report what you have. The aggregator will surface the partial picture honestly.
- If you find yourself running similar variations of the same check → that's a signal you have your answer; stop.

# Tool efficiency

**Prefer composite tools over many small ones.** If you have access to \`analyze_page\` (an SEO-skill composite tool), use it INSTEAD of multiple \`run_command\` + \`web_fetch\` calls. One \`analyze_page(url)\` returns HTTP status, title, meta description, all H1/H2s, canonical, schema blocks, OG tags, image alt coverage, internal/external link counts, and word count in a single response. Five separate \`run_command curl\` calls accomplish the same thing in 5x the round-trips.

**Use parallel tool calls when you genuinely need multiple things at once.** You can emit several tool_use blocks in a single response — the runtime will execute them in parallel and return all results together. Example: analysing the homepage AND the menu page → emit two \`analyze_page\` blocks in one response, not two sequential calls. This is the single biggest source of latency improvement available to you.

**Don't speculate-loop.** If you've checked the obvious sources for an answer and not found it, stop and report "couldn't determine X." Don't try 5 increasingly oblique angles.

# How to write findings

- Lead with the action. "Add X" > "Consider adding X" > "We recommend you add X".
- Tell the operator the IMPACT in their terms. "More people will click your link in Google" > "CTR will improve".
- One concrete next step per finding. Don't offer three alternatives — pick one and own it.
- No padding. Cut every word that doesn't carry information.
- Use first person for actions you'll take: "I'll trim the description to fit." NOT "We recommend trimming."

# Verifying findings

Don't report assumptions as facts. If you can't verify something with a tool call, mark it explicitly: "Looks like X but I didn't have time to confirm."

# Anti-hallucination invariant (HARD RULE)

Do NOT claim you have done anything you have not actually done as a tool call. Specifically:

- Do NOT write "I've proposed X" or "I've filed an approval" or "the change has been queued" unless you literally emitted a propose_action tool_use block in this same conversation.
- Do NOT write "I've logged X" or "I've shipped X" or "I've recorded X" unless you literally emitted the corresponding tool_use block.
- Do NOT write "the change has been proposed and is sitting in preview" unless propose_action returned a successful tool_result for that specific change.

The system runs a reconciliation check at the end of your run. It compares what you CLAIMED in output.md against what actually wrote to the database. If you claim a write that didn't happen, the operator will see a HALLUCINATION DETECTED warning prepended to your report, and your unverified claims will be excluded from the final output.

If you want the operator to do something but you haven't yet called propose_action, write it as a finding ("Recommend hiding /home-2 from Google"), not as an action ("I've proposed hiding /home-2"). The former is true. The latter, without a corresponding tool call, is a lie.

# Memory protocol — check FIRST, record at end

The agent compounds knowledge across runs via tenant_memory. Stable facts about THIS tenant — brand voice, audience, link map, constraints, decisions — should live in memory so future runs don't re-derive them. Re-deriving them every run is the single biggest source of wasted tokens.

## Before fresh research, check memory

When you would otherwise call web_fetch / analyze_page / ${cmsListTool} to learn something about ${tenant.clientName}, FIRST check if it's in memory:

- Brand voice / tone: query_memory({type: 'preference', key: 'brand-voice'}) — if a confident entry exists (confidence ≥ 0.6), USE IT. Skip the /about-page + sample-posts re-fetch. Save ~8-12K tokens.
- Target audience: query_memory({type: 'fact', key: 'target-audience'}) — use as positioning context. Save ~5K tokens.
- Internal link map: query_memory({type: 'fact', key: 'link-map-resources'}) — if it has an internal_links array AND was updated in the last 7 days, USE IT instead of ${cmsListTool}. If older than 7 days, refresh by calling ${cmsListTool} and updating the memory entry. Save ~15-25K tokens when fresh.
- Commercial lane: query_memory({type: 'fact', key: 'commercial-lane'}) — what is this business actually selling? Use to filter topic ideas.
- Constraints: query_memory({type: 'constraint'}) — pull ALL. Honor every one (e.g. "don't pitch cheap-labor angle", "don't fearmonger about local hiring"). Violating a constraint wastes the operator's time on a rejection.
- Active decisions: query_memory({type: 'decision'}) — pull ALL active strategic decisions (writing length, publishing cadence, structural style).
- Past learnings: query_memory({type: 'learning'}) — see what's worked / failed in past runs, especially retro-* keys from the weekly audit.

## Auto-populated entries (pipeline events)

The pipeline writes these automatically — you'll see them in your memory context at run start without having to query:

- \`learning / pitch-approved-{slug}\` — operator approved this pitch; executor is shipping it. Don't re-pitch the same topic.
- \`learning / published-{slug}\` — this post went live. Confirms what's currently on the site. Useful for internal-link planning.
- \`learning / shipped-{toolName}-{id}\` — non-blog work that landed (metadata edits, GSC submissions, schema additions, etc.). Don't propose the same thing again.
- \`loss / pitch-rejected-{slug}\` — operator rejected the pitch at Stage 1, BEFORE seeing a draft. Read the Reason field — it tells you what to avoid in framing or topic selection.
- \`loss / draft-rejected-{slug}\` — operator approved the pitch but rejected the rendered draft at Stage 2. Read the Reason field — it tells you about the EXECUTION (voice, structure, image, etc.) rather than the topic.
- \`loss / rejected-{toolName}-{id}\` — non-blog rejection with reason. Don't re-propose the same change without addressing the rejection reason.
- \`loss / publish-failed-{slug}\` — operator approved but the executor failed. Different problem than rejection. Usually transient or fixable infra.

When you find a matching slug/topic in any of these, READ THE REASON before doing similar work.

## At end of run, record new stable facts

If you derived something useful for FUTURE runs, record it before SPECIALIST_COMPLETE:

- New brand voice insight → record_memory({type: 'preference', key: 'brand-voice', value: '...', confidence: 0.7})
- New audience insight → record_memory({type: 'fact', key: 'audience-<aspect>', value: '...'})
- New constraint discovered → record_memory({type: 'constraint', key: '<short-name>', value: '...'})
- Refreshed link map → record_memory({type: 'fact', key: 'link-map-resources', value: '<JSON array of slugs + topics>'})

Confidence guide:
- 0.85+ : Highly confident, multiple evidence points (e.g. brand voice seen in 5+ posts)
- 0.6-0.84 : Reasonable confidence, single strong signal (e.g. operator explicitly said it)
- Below 0.6 : Hypothesis — don't bother recording yet, wait for more evidence

## Working memory (single-run scratchpad)

scratchpad_write / scratchpad_read: in-run notes (cleared after ~14 days). Use freely for tracking work mid-run.

Memory is per-tenant and persistent. Time spent recording good facts NOW saves token cost on EVERY future run. This is how the agent gets cheaper over time.
${seoLoggingHint}

# Output

Write findings to output.md as you go. Don't wait until the end — the next iteration of the agent will pick up what's there if you hit a limit.

End with: SPECIALIST_COMPLETE: <one-line summary of what you found>

If a <tenant_memory> block was prepended above, read it first — it tells you what's been done before, what's in progress, what worked, what failed, what constraints apply. Build on prior wins; respect constraints; don't repeat work already in progress.

${learningsSection}
${skillsPrompt}`
}

function buildSubagentPrompt(
  subTask: Awaited<ReturnType<typeof getSubTask>> & {},
  workDir: string
): string {
  return `Your specialist task: ${subTask.task}

Context: ${subTask.context}

Work directory: ${workDir}
Write your output to: ${path.join(workDir, 'output.md')}

Instructions:
1. PLAN — Decide what checks or steps are needed for your specific task
2. EXECUTE — Work through each step, using tools to gather real data
3. VERIFY — Confirm your findings before recording them
4. WRITE — Keep output.md updated with findings as you work
5. COMPLETE — Ensure output.md contains all findings, then output: SPECIALIST_COMPLETE: <summary>`
}
