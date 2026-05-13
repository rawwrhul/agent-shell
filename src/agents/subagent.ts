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
import { getContextSummary } from './progress'
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
import { cachedSystem, cachedTools } from '../lib/prompt-cache'
import {
  buildIntegrationToolsForTenant,
  isIntegrationToolName,
  executeIntegrationTool,
} from '../integrations'
import {
  captureBaselineCounts, reconcileOutput, ReconciliationCounts,
} from './reconciliation'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

// ── Iteration cap and retry policy ────────────────────────────────────────
const HARD_ITERATION_CAP = 15
const MAX_API_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000
const PER_CALL_TIMEOUT_MS = 90_000

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ECONNREFUSED',
])

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/** SEO tool names that mutate DB state. Stripped in investigate mode. */
const WRITE_SIDE_SEO_TOOL_NAMES = new Set([
  'propose_action',
  'log_seo_action',
  'log_opportunity',
  'snapshot_metrics',
  'upsert_cluster',
])

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
  const msg = (e.message ?? '').toLowerCase()
  if (msg.includes('econnreset') || msg.includes('timeout') || msg.includes('socket hang up')) {
    return true
  }
  return false
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

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
        attempt, max: MAX_API_RETRIES,
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
  const seoToolCtx = { tenantId: task.tenantId, runId: task.id, taskId: task.id, channelId: task.slackChannelId }

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }]
  let tokenCount = 0, toolCount = 0, finalOutput = ''

  const iterationCap = Math.min(config.AGENT_MAX_TURNS ?? HARD_ITERATION_CAP, HARD_ITERATION_CAP)

  try {
    let turns = 0
    while (turns < iterationCap) {
      turns++

      const response = await callAnthropicWithRetry({
        model:      tenant.agentModel,
        max_tokens: 8096,
        system:     cachedSystem(system),
        tools:      cachedTools(tools),
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

          // Integration tools (Framer, GSC, GA4, DataForSEO) — external APIs.
          // All integration tools here are READ-only or otherwise safe; writes
          // are routed through propose_action → execution worker, not direct
          // tool calls. No HITL hook needed here.
          if (isIntegrationToolName(tb.name)) {
            const output = await executeIntegrationTool(
              tb.name,
              tb.input as Record<string, unknown>,
              tenant,
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

        tokenCount += (summaryResponse.usage?.input_tokens ?? 0) + (summaryResponse.usage?.output_tokens ?? 0)

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
  - Then propose_action(toolName=..., toolInput=..., proposedAction="Trim homepage title from 87 to 52 chars", whyPriority="Currently truncating in search results")

## propose_action is the ONLY way to write a change for the operator

If you want the operator to do something (publish, edit, fix, change a setting on a tenant system), you call propose_action. That writes a row to approval_requests. The operator sees it in Slack and either approves (the executor worker then applies the change via the appropriate integration tool) or rejects.

You do NOT:
  - Apply changes directly via integration tools (framer_update_*, gsc_submit_*, etc.) — those are reserved for the executor worker, post-approval
  - Use log_seo_action to record "shipped" work the operator hasn't approved
  - Use snapshot_metrics or upsert_cluster as a substitute for propose_action

If the change is small and reversible (e.g. a memory/note for yourself), the memory tools and scratchpad are fine. Anything that touches the tenant's actual website or external accounts goes through propose_action.
`

  const seoLoggingHint = hasSeoSkill && taskIntent === 'propose_changes'
    ? `\nYou have SEO logging tools. When you ship work (post-approval, via the executor), find an opportunity, or measure a metric, write it to the database so the aggregator can build daily/weekly reports:
- log_seo_action: record completed actions (anything shipped, deployed, published) → seo_work_log
- log_opportunity: surface a finding worth doing later → seo_opportunities
- snapshot_metrics: snapshot a metric (rankings, indexed pages, CWV) → seo_metrics_snapshots
- upsert_cluster: update topical cluster state → seo_clusters
Use these aggressively. Anything not written to the DB doesn't appear in daily/weekly reports.\n`
    : ''

  return `You are the ${subTask.specialist_name} for ${tenant.clientName}, an agent built by Causal Growth Science.

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

# Memory tools

- record_memory: persist a learning, win, loss, or fact worth remembering across runs. Use sparingly.
- query_memory: read prior memories for this tenant.
- scratchpad_write / scratchpad_read: in-run notes (cleared after ~14 days; use freely).
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
