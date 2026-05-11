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
//   R2: tenant memory context prepended to system prompt + memory tools
//       (record_memory, query_memory, scratchpad_write, scratchpad_read).
//   R3.1: SEO tool dispatch (tenants with the 'seo' skill get
//         log_work / record_opportunity / log_metric / log_cluster_progress
//         tools that write to seo_work_log / seo_opportunities /
//         seo_metrics_snapshots / seo_clusters). DB-only side effects, no
//         HITL hook required. Without these tools the daily/weekly
//         aggregator can't pull "shipped overnight" / "metrics" / "cluster
//         progress" from anywhere — narrative-only specialists produce
//         empty daily/weekly reports.
//   R3.1: bounded retries on the Anthropic API call (ECONNRESET, 5xx, 429,
//         timeouts) with exponential backoff. Prevents the runaway loop
//         observed in prod when intermediate hops killed streaming
//         connections — every tool call was retrying forever.
//   R3.1: hard iteration cap separate from config.AGENT_MAX_TURNS, in case
//         that value is set high. Defaults to min(AGENT_MAX_TURNS, 15).

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
import { getContextSummary } from './progress'
import { retrieveRelevant } from '../memory/vector'
import { startTrace, endTrace, recordUsage } from '../observability/langfuse'
import { createRunRecord, completeRunRecord } from '../memory/postgres'
import {
  getSubTask, startSubTask, completeSubTask, failSubTask,
  allSubtasksComplete, anySubtaskSucceeded,
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

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

// ── Iteration cap and retry policy ────────────────────────────────────────
//
// Hard cap: 15 iterations per executor run, regardless of config setting.
// If config.AGENT_MAX_TURNS is set lower, that wins. Higher → still capped
// at 15. Empirically a converging task runs in 3-8 iterations.
const HARD_ITERATION_CAP = 15

// Anthropic call retry policy. We retry on transient network/server errors;
// permanent errors (4xx other than 429, malformed request) fail fast.
const MAX_API_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000  // 1s, then 2s, then 4s
const PER_CALL_TIMEOUT_MS = 90_000  // 90s upper bound per model call

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ECONNREFUSED',
])

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])

interface AnthropicErrorLike {
  code?: string
  status?: number
  cause?: { code?: string }
  message?: string
}

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as AnthropicErrorLike

  const code = e.code ?? e.cause?.code
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true

  if (typeof e.status === 'number' && TRANSIENT_HTTP_STATUSES.has(e.status)) return true

  // String-matching fallback for SDK errors that don't expose code
  const msg = (e.message ?? '').toLowerCase()
  if (msg.includes('econnreset') || msg.includes('timeout') || msg.includes('socket hang up')) {
    return true
  }
  return false
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Wrap an Anthropic.messages.create call with bounded retries and a
 * per-attempt timeout. Permanent errors throw immediately. Transient
 * errors retry up to MAX_API_RETRIES times with exponential backoff.
 */
async function callAnthropicWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming,
  attempt = 1,
): Promise<Anthropic.Message> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS)

  try {
    const response = await anthropic.messages.create(params, {
      signal: controller.signal,
    })
    return response
  } catch (err) {
    if (attempt >= MAX_API_RETRIES || !isTransientError(err)) {
      logger.error('anthropic_call_failed', {
        attempt,
        max: MAX_API_RETRIES,
        transient: isTransientError(err),
        err: String(err).slice(0, 400),
      })
      throw err
    }
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
    logger.warn('anthropic_call_retrying', {
      attempt, nextAttempt: attempt + 1, delayMs: delay, err: String(err).slice(0, 200),
    })
    await sleep(delay)
    return callAnthropicWithRetry(params, attempt + 1)
  } finally {
    clearTimeout(timeout)
  }
}

// ── Tool builders ─────────────────────────────────────────────────────────

function buildToolsForSpecialist(opts: { tenantSkills: string[] }): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [...AGENT_TOOLS, ...MEMORY_TOOLS]
  if (opts.tenantSkills.includes('seo')) {
    tools.push(...SEO_TOOLS)
  }
  return tools
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function runSubagent(task: AgentTask, subTaskId: string, tenant: TenantConfig): Promise<void> {
  const subTask = await getSubTask(subTaskId)
  if (!subTask) throw new Error(`SubTask ${subTaskId} not found`)

  const sessionId = uuid()
  const runId     = uuid()

  // Each subagent gets its own subdirectory inside the parent task directory
  const workDir = path.resolve(config.PROGRESS_DIR, task.id, 'subagents', subTask.specialist_type)
  fs.mkdirSync(workDir, { recursive: true })

  logger.info('subagent_start', {
    tenantId:       task.tenantId,
    taskId:         task.id,
    subTaskId,
    specialistType: subTask.specialist_type,
  })

  await startSubTask(subTaskId)
  await createRunRecord({ id: runId, tenantId: task.tenantId, taskId: `${task.id}:${subTask.specialist_type}`, agentType: subTask.specialist_type, sessionId })
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: subTask.specialist_type, billingTag: tenant.billingTag, userId: task.slackUserId })

  await presenter.recordSpecialistStart(task.id, subTask.specialist_type)

  const hookCtx = { taskId: task.id, sessionId, agentType: subTask.specialist_type, tenant, channelId: task.slackChannelId }
  const learnings = await retrieveRelevant({ tenantId: task.tenantId, agentType: subTask.specialist_type, query: subTask.task, topK: 3 })

  // Pull tenant memory (L2). Best-effort — first runs and DB hiccups
  // both yield an empty block.
  let memoryPrompt = ''
  try {
    const ctx = await getMemoryContext({
      tenantId: task.tenantId,
      taskType: subTask.specialist_type,
      tokenBudget: 1500,
    })
    memoryPrompt = toPromptString(ctx)
  } catch (err) {
    logger.warn('subagent_memory_load_failed', { subTaskId, err: String(err) })
  }

  const baseSystem = buildSubagentSystem(subTask, tenant, learnings)
  const system     = memoryPrompt ? `${memoryPrompt}\n\n${baseSystem}` : baseSystem
  const userMsg    = buildSubagentPrompt(subTask, workDir)

  // Specialists get standard agent tools + memory tools + SEO tools (if
  // the tenant has the 'seo' skill). SEO and memory tools are DB-only
  // side effects and bypass the HITL hook.
  const tools = buildToolsForSpecialist({ tenantSkills: tenant.skills })
  const memoryToolCtx = { tenantId: task.tenantId, runId: task.id }
  const seoToolCtx = { tenantId: task.tenantId, runId: task.id, taskId: task.id }

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }]
  let tokenCount = 0, toolCount = 0, finalOutput = ''

  // Hard iteration cap — min(config setting, HARD_ITERATION_CAP)
  const iterationCap = Math.min(config.AGENT_MAX_TURNS ?? HARD_ITERATION_CAP, HARD_ITERATION_CAP)

  try {
    let turns = 0
    while (turns < iterationCap) {
      turns++

      const response = await callAnthropicWithRetry({
        model:      tenant.agentModel,
        max_tokens: 8096,
        system,
        tools,
        messages,
      })

      tokenCount += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)

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

          // Memory tools (R2) — DB-only, no hook
          if (isMemoryToolName(tb.name)) {
            const output = await executeMemoryTool(
              tb.name,
              tb.input as Record<string, unknown>,
              memoryToolCtx,
            )
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
            continue
          }

          // SEO tools (R3.1) — DB-only, no hook
          if (isSeoToolName(tb.name)) {
            const output = await executeSeoTool(
              tb.name,
              tb.input as Record<string, unknown>,
              seoToolCtx,
            )
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

          const output = await executeTool(tb.name, tb.input as Record<string,unknown>, workDir)
          results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: results })
      }
    }

    if (turns >= iterationCap && !finalOutput) {
      // Cap hit without natural completion. Take what we have.
      logger.warn('subagent_iteration_cap_hit', {
        taskId: task.id, subTaskId, specialistType: subTask.specialist_type,
        cap: iterationCap, toolCount, tokenCount,
      })
      // Pull last assistant text if any
      const lastAsst = [...messages].reverse().find(m => m.role === 'assistant')
      if (lastAsst && Array.isArray(lastAsst.content)) {
        finalOutput = lastAsst.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('') ||
          `Subagent hit iteration cap (${iterationCap}) before reaching natural completion. Partial findings only.`
      } else {
        finalOutput = `Subagent hit iteration cap (${iterationCap}) before reaching natural completion.`
      }
    }

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
  learnings: Array<{ content: string }>
): string {
  const skillsPrompt = buildTenantSkillsPrompt(subTask.skills)
  const learningsSection = learnings.length
    ? `## Relevant past learnings\n${learnings.map(l => `- ${l.content}`).join('\n')}\n`
    : ''

  const hasSeoSkill = (subTask.skills ?? []).includes('seo') || tenant.skills.includes('seo')
  const seoLoggingHint = hasSeoSkill
    ? `\nYou have SEO logging tools. When you ship work, find an opportunity, or measure a metric, write it to the database so the aggregator can build daily/weekly reports:
- log_work: record completed actions (anything shipped, deployed, published) → seo_work_log
- record_opportunity: surface a finding worth doing later → seo_opportunities
- log_metric: snapshot a metric (rankings, indexed pages, CWV) → seo_metrics_snapshots
- log_cluster_progress: update topical cluster state → seo_clusters
Use these aggressively. Anything not written to the DB doesn't appear in daily/weekly reports.\n`
    : ''

  return `You are the ${subTask.specialist_name} for ${tenant.clientName}, deployed by Causal Growth Science.

You are ONE specialist in a team of parallel agents. Each agent handles a specific area.
Your job is to complete YOUR specific task thoroughly and write structured output to output.md.

If a <tenant_memory> block was prepended above, read it first — it tells you what's been done before, what's in progress, what worked, what failed, what constraints apply. Build on prior wins; respect constraints; don't repeat work already in progress.

You have memory tools available:
- record_memory: persist a learning, win, loss, or fact worth remembering across runs. Use sparingly — only for things genuinely worth carrying forward.
- query_memory: read prior memories for this tenant.
- scratchpad_write / scratchpad_read: in-run notes (cleared after ~14 days; use freely).
${seoLoggingHint}
Rules:
- Focus ONLY on your specific task. Do not attempt work outside your scope.
- Be thorough. Your output is used by an aggregator to build the final client report.
- Verify your findings — do not report assumptions as facts.
- Write findings to output.md as you go. Don't wait until the end.
- End with: SPECIALIST_COMPLETE: <one-line summary of what you found>

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
