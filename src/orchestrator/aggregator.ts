// src/orchestrator/aggregator.ts
//
// R3.1 — Structured FinalReport output.
//
// Triggered automatically when all subagents for a task have completed.
// Reads each subagent's output, synthesises it into a STRUCTURED report
// (AdHocCheckReport / DailyRunReport / WeeklyAuditReport per task.trigger),
// then hands it to the SlackPresenter — which renders it inline in the run's
// anchor message via the matching Block Kit renderer.
//
// What changed from R3 (pre-finishing):
//   - System prompt is now trigger-aware: three distinct prompts (ad-hoc,
//     daily, weekly), each asking the model to emit JSON matching the
//     corresponding report shape.
//   - Output is parsed as JSON and validated; on parse failure we fall back
//     to passing the raw text through to `presenter.completeRun` so the
//     legacy summary path renders rather than the run failing.
//   - Markdown links and bold markers in plan/finding text are normalised
//     to Slack mrkdwn before storage in render.ts → this file just passes
//     structured text fields through, the renderer normalises on output.
//
// Graceful degradation: if JSON parsing fails (model emits prose, fence-
// wrapped output that can't be cleaned, schema mismatch), the raw string
// goes through to presenter.completeRun(taskId, string) which renders as
// the legacy summary. The run completes either way — never blocked on
// model output quality.

import Anthropic      from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import path           from 'path'
import fs             from 'fs'
import { config }     from '../config'
import { AgentTask, TaskTrigger }  from '../types'
import { TenantConfig } from '../tenants/types'
import { getSubtasks } from '../memory/subtasks'
import { presenter }   from '../core/slack'
import { startTrace, endTrace } from '../observability/langfuse'
import { logger } from '../logger'
import type { FinalReport } from '../core/slack/blocks/types'
import { cachedSystem } from '../lib/prompt-cache'
import {
  loadDailyDifferential, loadWeeklyDifferential,
  formatDailyDifferentialForPrompt, formatWeeklyDifferentialForPrompt,
} from './cron-context'
import { pickForDailyRun } from '../core/opportunity-bank'
import { createApprovalCardsForSurfaced } from '../core/opportunity-bank/card-builder'
import { pool as bankPool } from '../memory/postgres'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

// ── Entry point ───────────────────────────────────────────────────────────

export async function runAggregator(task: AgentTask, tenant: TenantConfig): Promise<void> {
  const sessionId = uuid()
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: 'aggregator', billingTag: tenant.billingTag, userId: task.slackUserId })

  const trigger: TaskTrigger = task.trigger ?? 'slack-mention'
  logger.info('aggregator_start', { tenantId: task.tenantId, taskId: task.id, trigger })

  try {
    // Load all subagent outputs
    const subtasks = await getSubtasks(task.id)
    const completed = subtasks.filter(s => s.status === 'completed' && s.output)

    if (!completed.length) {
      logger.error('aggregator_no_outputs', { taskId: task.id })
      await presenter.failRun(task.id, 'No specialist outputs available — every specialist failed.')
      await endTrace(sessionId, 'error')
      return
    }

    // Pull detailed output from disk where present
    const outputs = completed.map(s => {
      const outputPath = path.resolve(config.PROGRESS_DIR, task.id, 'subagents', s.specialist_type, 'output.md')
      let fullOutput = s.output ?? ''
      if (fs.existsSync(outputPath)) {
        fullOutput = fs.readFileSync(outputPath, 'utf-8')
      }
      return { specialistType: s.specialist_type, specialistName: s.specialist_name, summary: s.summary ?? '', fullOutput }
    })

    logger.info('aggregator_inputs_loaded', {
      taskId: task.id,
      specialists: outputs.map(o => o.specialistType),
      trigger,
    })

    // Transition phase before the LLM call so the channel reflects
    // "synthesising" while the model is working.
    await presenter.setPhase(task.id, 'synthesising')

    // For cron triggers, load a differential context block (today vs
    // yesterday for daily; this week vs prior week for weekly) and
    // inject it into the user prompt. Lets the aggregator frame the
    // report as a delta rather than restating prior work, and lets it
    // emit honest "no material change" reports without padding.
    let differentialBlock = ''
    if (trigger === 'cron-daily') {
      const diff = await loadDailyDifferential(task.tenantId)
      differentialBlock = formatDailyDifferentialForPrompt(diff)

      // ── Bank consumption ────────────────────────────────────────────
      // Pick a diverse batch from the opportunity bank and atomically
      // transition them new → surfaced. The LLM is told about them
      // below so it includes them in 'newOpportunities' of its output.
      // Best-effort: any failure falls back to inline-only behaviour.
      try {
        const surfaced = await pickForDailyRun({
          tenantId: task.tenantId,
          runId:    task.id,
        })
        if (surfaced.length > 0) {
          differentialBlock += '\n\n## Opportunities surfaced from the bank this run\n\n'
            + 'These were filed by background runs (audit, future discovery skills) and have just been promoted from the bank into this customer-facing batch. They are now status=surfaced with surfaced_in_run_id stamped to this task. **Include each of them in the `newOpportunities` array of your structured output**, alongside any new ones the specialist discovered inline. Each one also has its own approval card created — the operator will see Approve/Reject/Defer buttons inline in your final anchor message.\n\n'
            + surfaced.map((o) =>
                `- [${o.priority}] ${o.type} (id: ${o.id}): ${o.description}${o.target ? ' — ' + o.target : ''}`
              ).join('\n')
          logger.info('aggregator_surfaced_from_bank', {
            taskId: task.id, tenantId: task.tenantId, count: surfaced.length,
          })

          // Create one approval_requests row per surfaced opportunity.
          // Aggregator's anchor message renderer picks these up via existing
          // query and inlines them as Block Kit action buttons.
          try {
            const cardResult = await createApprovalCardsForSurfaced({
              pool:          bankPool,
              opportunities: surfaced,
              taskId:        task.id,
              tenant,
            })
            logger.info('approval_cards_for_surfaced_complete', {
              taskId:             task.id,
              tenantId:           task.tenantId,
              cardsCreated:       cardResult.cardsCreated,
              autoExecuted:       cardResult.autoExecuted,
              skippedUnsupported: cardResult.skippedUnsupported,
              errorCount:         cardResult.errors.length,
            })
          } catch (err) {
            logger.warn('approval_cards_for_surfaced_failed', {
              taskId: task.id, err: String(err).slice(0, 300),
            })
          }
        }
      } catch (err) {
        logger.warn('aggregator_bank_surface_failed', {
          taskId: task.id, err: String(err).slice(0, 300),
        })
      }
      logger.info('aggregator_daily_differential_loaded', {
        taskId: task.id, materialActivity: diff.materialActivityToday, firstRun: diff.firstRun,
      })
    } else if (trigger === 'cron-weekly') {
      const diff = await loadWeeklyDifferential(task.tenantId)
      differentialBlock = formatWeeklyDifferentialForPrompt(diff)
      logger.info('aggregator_weekly_differential_loaded', {
        taskId: task.id, materialActivity: diff.materialActivityThisWeek, firstRun: diff.firstRun,
      })
    }

    // Single Claude call to synthesise — system prompt picked by trigger.
    const systemPrompt = getAggregatorSystemPromptFor(trigger, tenant)
    const pendingApprovalsBlock = await loadPendingApprovalsForPrompt(task.id)
    const userPrompt = buildAggregatorUserPrompt(task, outputs, trigger, differentialBlock, pendingApprovalsBlock)

    const response = await anthropic.messages.create({
      model:      tenant.agentModel,
      max_tokens: 8096,
      // Cache the system prompt — it's deterministic per (trigger, tenant)
      // pair, so daily/weekly cron runs hit the cache reliably. Specialist
      // outputs (in messages) vary per run and stay uncached.
      system:     cachedSystem(systemPrompt),
      messages:   [{ role: 'user', content: userPrompt }],
    }, {
      // Explicit 3-min timeout. Default SDK timeout is 10min which is
      // longer than BullMQ's default 30s lockDuration — caused silent
      // hangs + retry cascades. 180s fits comfortably under the new
      // 5-min lockDuration set in src/queue/worker.ts.
      timeout: 180_000,
    })

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')

    // Persist raw output for debugging regardless of parse outcome.
    const reportPath = path.resolve(config.PROGRESS_DIR, task.id, 'final-report.md')
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, rawText, 'utf-8')

    // Attempt structured parse. On failure, give the model one round-trip
    // to fix the JSON before falling back to the legacy summary path.
    let parsed = parseAggregatorOutput(rawText, trigger, task, tenant)

    if (!parsed.ok) {
      logger.warn('aggregator_parse_failed_attempting_retry', {
        taskId: task.id, reason: parsed.reason, rawLength: rawText.length,
      })
      try {
        const retry = await anthropic.messages.create({
          model:      tenant.agentModel,
          max_tokens: 8096,
          system:     cachedSystem(systemPrompt),
          messages:   [
            { role: 'user',      content: userPrompt },
            { role: 'assistant', content: rawText },
            { role: 'user',      content:
              `Your previous response failed to parse as valid JSON matching the required schema. ` +
              `Parser error: ${parsed.reason}\n\n` +
              `Output ONLY the corrected JSON object. No prose. No markdown fences. ` +
              `Start with { and end with }. Match the exact schema in the system prompt.`,
            },
          ],
        }, { timeout: 90_000 })

        const retryText = retry.content
          .filter(b => b.type === 'text')
          .map(b => (b as Anthropic.TextBlock).text)
          .join('')

        const retryReportPath = path.resolve(config.PROGRESS_DIR, task.id, 'final-report-retry.md')
        fs.writeFileSync(retryReportPath, retryText, 'utf-8')

        const retryParsed = parseAggregatorOutput(retryText, trigger, task, tenant)
        if (retryParsed.ok) {
          logger.info('aggregator_parse_retry_succeeded', { taskId: task.id })
          parsed = retryParsed
        } else {
          logger.warn('aggregator_parse_retry_also_failed', {
            taskId: task.id, retryReason: retryParsed.reason,
          })
        }
      } catch (err) {
        logger.warn('aggregator_parse_retry_threw', {
          taskId: task.id, err: String(err).slice(0, 300),
        })
      }
    }

    if (parsed.ok) {
      await presenter.completeRun(task.id, parsed.report)
      logger.info('aggregator_complete', {
        taskId: task.id,
        kind: parsed.report.kind,
        rawLength: rawText.length,
        tokenCount: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      })
    } else {
      logger.warn('aggregator_structured_parse_failed_falling_back', {
        taskId: task.id,
        reason: parsed.reason,
        rawLength: rawText.length,
      })
      await presenter.completeRun(task.id, rawText)
    }

    await endTrace(sessionId, 'success', `Final report generated — ${rawText.length} chars`)
  } catch (err) {
    logger.error('aggregator_failed', { taskId: task.id, err: String(err).slice(0, 500) })
    // Wrap failRun + endTrace in their own timeouts so a hung Slack/
    // Langfuse call can't trap us in the failure path indefinitely.
    await Promise.race([
      presenter.failRun(task.id, String(err).slice(0, 400)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('failrun_timeout')), 30_000)),
    ]).catch((failErr) => logger.warn('aggregator_failrun_failed', { taskId: task.id, err: String(failErr).slice(0, 200) }))
    await Promise.race([
      endTrace(sessionId, 'error'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('endtrace_timeout')), 10_000)),
    ]).catch(() => { /* swallow — already in failure path */ })
    throw err
  }
}

// ── Output parsing ────────────────────────────────────────────────────────

type ParseResult =
  | { ok: true; report: FinalReport }
  | { ok: false; reason: string }

/**
 * Parse the aggregator's raw text output as a structured FinalReport.
 *
 * Steps:
 *   1. Strip stray markdown code fences (models love to wrap JSON in ```json)
 *   2. Strip any prose preamble before the first `{`
 *   3. JSON.parse
 *   4. Validate `kind` matches the expected trigger
 *
 * Returns ok+report on success, ok=false+reason on failure (caller falls
 * back to passing rawText through).
 */
export function parseAggregatorOutput(
  raw: string,
  trigger: TaskTrigger,
  task: AgentTask,
  tenant: TenantConfig,
): ParseResult {
  const cleaned = stripCodeFences(raw).trim()

  // Find first '{' — anything before is preamble.
  const firstBrace = cleaned.indexOf('{')
  if (firstBrace === -1) {
    return { ok: false, reason: 'no_json_object_in_output' }
  }
  const lastBrace = cleaned.lastIndexOf('}')
  if (lastBrace <= firstBrace) {
    return { ok: false, reason: 'unclosed_json_object' }
  }
  const jsonText = cleaned.slice(firstBrace, lastBrace + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    return { ok: false, reason: `json_parse_error: ${String(err).slice(0, 200)}` }
  }

  if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
    return { ok: false, reason: 'missing_kind_field' }
  }

  const kind = (parsed as { kind: unknown }).kind

  // Expected kind by trigger.
  const expectedKind = expectedKindFor(trigger)
  if (kind !== expectedKind) {
    return { ok: false, reason: `kind_mismatch: got ${String(kind)}, expected ${expectedKind}` }
  }

  // Light shape validation — make sure required arrays exist as arrays.
  // We don't deep-validate; the renderer is defensive about empty arrays.
  const report = parsed as FinalReport

  // Fill in identity fields the model can't know.
  const enriched = enrichWithIdentity(report, task, tenant)

  if (!validateMinimal(enriched)) {
    return { ok: false, reason: 'minimal_shape_validation_failed' }
  }

  return { ok: true, report: enriched }
}

function stripCodeFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

function expectedKindFor(trigger: TaskTrigger): FinalReport['kind'] {
  switch (trigger) {
    case 'cron-daily':   return 'daily'
    case 'cron-weekly':  return 'weekly'
    // Phase 9a: ad-hoc Slack-mention runs default to the tight response
    // shape — single-task runs that produced an approval card don't need
    // the full TL;DR/broken/working/leverage structure.
    default:             return 'ad_hoc_tight'
  }
}

/**
 * The model knows the report contents but not the run's identity fields
 * (tenantName, tenantSlug, runId, dates). We attach those here.
 */
function enrichWithIdentity(report: FinalReport, task: AgentTask, tenant: TenantConfig): FinalReport {
  const base = {
    tenantName: tenant.clientName,
    tenantSlug: task.tenantId,
    runId:      task.id,
  }

  if (report.kind === 'ad_hoc') {
    return { ...report, ...base }
  }
  if (report.kind === 'ad_hoc_tight') {
    return { ...report, ...base }
  }
  if (report.kind === 'daily') {
    return {
      ...report,
      ...base,
      runDate: new Date(),
      trigger: task.trigger === 'cron-daily' ? 'cron' : 'on_demand',
    }
  }
  return {
    ...report,
    ...base,
    weekStart: weekStart(new Date()),
    trigger: task.trigger === 'cron-weekly' ? 'cron' : 'on_demand',
  }
}

function weekStart(d: Date): Date {
  const wd = d.getDay() // 0=Sun
  const monday = new Date(d)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(d.getDate() - ((wd + 6) % 7))
  return monday
}

function validateMinimal(report: FinalReport): boolean {
  // Phase 9a: ad_hoc_tight doesn't have tldr — handle separately.
  if (report.kind === 'ad_hoc_tight') {
    return typeof report.title   === 'string' && report.title.length   > 0
        && typeof report.summary === 'string' && report.summary.length > 0
        && typeof report.why     === 'string' && report.why.length     > 0
  }

  if (!report.tldr || !Array.isArray(report.tldr) || report.tldr.length === 0) return false

  if (report.kind === 'ad_hoc') {
    return Array.isArray(report.broken)
        && Array.isArray(report.working)
        && Array.isArray(report.leverage)
        && typeof report.title === 'string'
        && report.title.length > 0
  }
  if (report.kind === 'daily') {
    return Array.isArray(report.shippedActions)
        && Array.isArray(report.newOpportunities)
        && Array.isArray(report.queuedForToday)
        && Array.isArray(report.awaitingApproval)
  }
  // weekly
  return Array.isArray(report.topPriorities)
      && Array.isArray(report.clusterProgress)
      && Array.isArray(report.riskFlags)
      && Array.isArray(report.stateOfPlay)
      && !!report.summary
}

// ── System prompts ────────────────────────────────────────────────────────

export function getAggregatorSystemPromptFor(trigger: TaskTrigger, tenant: TenantConfig): string {
  switch (trigger) {
    case 'cron-daily':  return buildDailySystem(tenant)
    case 'cron-weekly': return buildWeeklySystem(tenant)
    default:            return buildAdHocSystem(tenant)
  }
}

// Phase 9a: tight ad-hoc system prompt — for single-task Slack-mention
// runs where the meaningful output is the approval card, not a report.
function buildAdHocSystem(tenant: TenantConfig): string {
  return `You are the aggregator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.

You have just received the outputs of one or more specialists who worked on the operator's ad-hoc request. Most of the time this is a focused, single-task run (e.g. 'draft me a blog post') where the meaningful next step is already queued in the approval system. Your job is to produce a TIGHT summary, not a full report.

# Who you're writing for

${tenant.clientName}'s operator — they run the business. They asked for one thing; they want one tight answer plus the approval card already in the thread. Don't pad. Don't add a TL;DR if a single sentence covers it.

Translate ALL technical concepts. NEVER use jargon. Common translations:
- 'SERP' → 'search results'
- 'CTR' → 'how often people click your listing'
- 'meta description' → 'the summary under your title in search results'
- 'meta title', 'title tag' → 'the headline in search results'
- 'schema markup' → 'behind-the-scenes labels that help Google understand your page'
- 'indexed' → 'showing up in Google'
- 'backlinks' → 'links pointing to your site from other websites'

# Output schema

Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences. No explanation. JSON only.

{
  "kind": "ad_hoc_tight",
  "title": "<4-8 words, action-first. e.g. \"Drafted: Time zone objection post\", \"Audit complete: 3 issues\", \"Topic queued for review\"">,
  "summary": "<one sentence, past tense, action-first — what got done in this run. 15-30 words. No jargon.>",
  "why": "<one sentence — why this matters for the business. 12-25 words. Outcome-focused.>",
  "notes": [
    "<optional 0-2 short context bullets — only when genuinely useful. e.g. \"Existing post on /agency-markups got 340 impressions last 28 days — adjacent topic\". MOST runs leave this empty.>"
  ]
}

# Voice and framing

- First-person commitment, not directive. YES: "I drafted a post on...". NO: "A post has been drafted...".
- Lead with the action, then the impact in the why line.
- Plain prose. The Slack renderer handles emphasis.
- Numbers and percentages where you have them — don't invent them.

# Rules

- title, summary, why are all MANDATORY.
- notes is optional and usually empty. Only include when the operator would benefit from a concrete piece of context (a number, a comparison, a constraint).
- NEVER produce broken/working/leverage fields. That schema is for cron daily/weekly reports, not ad-hoc.
- If the specialist failed, set summary to a one-line failure description and why to a one-line on what the operator should do (file a bug, retry, etc.). Leave notes empty.
`
}

function buildAdHocFullSystem(tenant: TenantConfig): string {
  // Kept for legacy callers — produces the structured TL;DR/broken/working/leverage shape.
  return `You are the aggregator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.

You have just received the outputs of one or more specialist subagents who worked on a user's ad-hoc request. Synthesise their findings into a single structured report.

# Who you're writing for

The person reading this is ${tenant.clientName}'s operator — they run the business, not an SEO agency. They want clear, actionable findings in their language. Every word you write needs to be useful to them.

Translate ALL technical concepts. NEVER use these terms as-is:
- "SERP" → "search results"
- "CTR" → "how often people click your listing in search results"
- "topical authority" → "Google's understanding of what your business is about"
- "canonical" → "the 'official' version of a page that Google should rank"
- "crawler" → "Google's discovery tools"
- "H1", "H2", "H3" → "main headline", "section headings"
- "meta description" → "the summary under your title in search results"
- "meta title", "title tag" → "the headline in search results"
- "schema markup", "JSON-LD", "structured data" → "behind-the-scenes labels that help Google understand your page"
- "robots.txt" → "the file that tells Google which pages to ignore"
- "sitemap" → "the map of your site Google reads"
- "indexed" → "showing up in Google"
- "noindex", "de-indexed" → "hidden from Google"
- "keyword dilution / cannibalisation" → "Google getting confused about what the page is about"
- "backlinks" → "links pointing to your site from other websites"
- "Core Web Vitals", "LCP", "CLS" → "page loading speed"

If you find yourself reaching for jargon, rewrite the sentence. The operator should be able to read every finding without a glossary.

# Output schema

Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences. No explanation. JSON only.

{
  "kind": "ad_hoc",
  "title": "<short title for the run, e.g. 'Homepage check', 'Why isn't /menu showing up', 'Site review'>",
  "subtitle": "<optional one-line context: domain · scope · notable scope detail>",
  "tldr": [
    "<3-5 bullet points, each one outcome-focused, plain prose, no markdown, ZERO jargon>",
    "<each bullet 8-25 words, scan-readable on mobile>",
    "<lead with the most important finding>"
  ],
  "broken": [
    {
      "severity": "<critical|high|medium|low>",
      "priority": "<P0|P1|P2|P3>",
      "text": "<the issue, in plain language: 'Your /menu page is missing its main headline' NOT 'H1 missing on /menu'>",
      "meta": "<optional short tag, e.g. '195 chars' or 'P0'>"
    }
  ],
  "working": [
    "<things that are working well, one line each, plain language>"
  ],
  "leverage": [
    {
      "priority": "<P0|P1|P2|P3>",
      "title": "<short action title, 4-8 words, lead with verb, plain language>",
      "detail": "<1-2 sentences: what I'll do, why it matters to THEIR business, no jargon>",
      "estImpact": "<short impact in operator terms: 'more clicks from search' / '+10% est. clicks' — not '+10% CTR'>"
    }
  ]
}

# Voice and framing

- First-person commitment, not directive.
  YES: "I'll trim the description so the full thing shows up in search results."
  NO:  "You should reduce meta description length to avoid SERP truncation."
- Lead with the action, then the impact.
  YES: "Removing the duplicate headline will help Google understand what the page is about."
  NO:  "Duplicate H1s dilute topical authority and confuse crawlers."
- Outcome over observation. Tell them what happens for THEIR business if the fix lands.

# Rules

- TL;DR mandatory: 3-5 bullets, scan-readable on mobile, ZERO jargon.
- "broken" array: severity + priority required. Order by severity desc, then priority asc.
- "working" array can be empty (don't fabricate positives).
- "leverage" array: 1-3 items only. The HIGHEST-leverage moves.
- Plain prose, no markdown formatting. The Slack renderer handles emphasis.
- Numbers and percentages where you have them — don't invent them.

# When specialist data is incomplete

If a specialist hit its work budget and reported partial findings:
- DO produce a useful report from what they DID find.
- DO NOT lead with "audit incomplete" or "re-run with higher budget" — that's a failure mode, not a finding.
- DO mention partial coverage in ONE TL;DR bullet at the end ("Couldn't fully check X — running again would surface more"), but the rest of the report leads with actual findings.
- The user typed a request expecting findings. Give them findings. The work-budget mention is footnote, not headline.`
}

function buildDailySystem(tenant: TenantConfig): string {
  const businessBriefBlock = tenant.businessBrief
    ? `\n# About ${tenant.clientName} — AUTHORITATIVE ground truth, do not infer otherwise from the name\n${tenant.businessBrief}\n`
    : ''
  return `You are the aggregator for ${tenant.clientName}'s daily ${tenant.agentType} run, built by Causal Growth Science.
${businessBriefBlock}
The agent has just executed the daily SEO loop. Synthesise the outputs into a single structured daily report.

# Who you're writing for

${tenant.clientName}'s operator runs the business, not an SEO agency. Write everything in plain language. Translate ALL technical concepts:
- "SERP" → "search results"
- "CTR" → "clicks from search"
- "H1" / "meta description" / "title tag" → "headline" / "search result summary" / "search result title"
- "schema markup" / "structured data" → "behind-the-scenes labels"
- "indexed" → "showing in Google"
- "canonical" → "official version"
- "topical authority" → "Google's understanding of your business"

If you find yourself using jargon, rewrite the sentence.

# Output schema

Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences.

{
  "kind": "daily",
  "tldr": [
    "<3-5 bullets summarising overnight shipped + queued + awaiting approval state>",
    "<lead with the most consequential outcome of the day, in operator language>",
    "<one bullet on what needs the operator's attention>"
  ],
  "shippedActions": [
    {
      "id": "<UUID from seo_work_log if available, else generate one>",
      "title": "<what shipped, lead with verb, plain language: 'Added customer review labels to /menu' NOT 'Added Review schema'>",
      "detail": "<optional 1-line context or impact in operator terms>",
      "executedAt": "<ISO datetime>",
      "status": "<success|partial>"
    }
  ],
  "newOpportunities": [
    {
      "id": "<UUID if available, else generate>",
      "description": "<opportunity in plain language, outcome-focused>",
      "priority": "<P0|P1|P2>"
    }
  ],
  "queuedForToday": [
    {
      "id": "<UUID>",
      "title": "<what's queued, verb-led, plain language>",
      "estimateMinutes": <integer or null>
    }
  ],
  "awaitingApproval": [
    {
      "id": "<approval_requests.id UUID>",
      "title": "<short title, plain language>",
      "detail": "<1-line context for the operator, no jargon>",
      "pendingSince": "<ISO datetime>",
      "severity": "<critical|high|medium|low>",
      "approvalUrl": "<optional Sheets deeplink>"
    }
  ]
}

# Voice and framing

- "Shipped overnight" framing for shippedActions — past tense, factual, operator language.
- "I'm planning to ship" framing for queuedForToday — first-person commitment.
- "Needs your call" framing for awaitingApproval — operator-respectful, briefly describe what they're approving in their terms.
- Strategic, not transactional. TL;DR should contextualise impact for the business, not just list actions.

# Rules

- Pull "shippedActions" from seo_work_log entries created in this run.
- Pull "newOpportunities" from new seo_opportunities (status='open', created in this run).
- Pull "queuedForToday" from seo_opportunities with priority=P0/P1 not yet shipped.
- Pull "awaitingApproval" from approval_requests where status='pending' and (defer_until IS NULL OR defer_until < now()).
- Empty arrays are FINE if nothing fits — don't fabricate to fill space.
- TL;DR doesn't repeat the lists — it summarises and contextualises.

# Authoritative ground truth

Each specialist's output may end with a "## Verified DB writes" section. That section lists what actually wrote to the database during the specialist's run. It is AUTHORITATIVE. If a specialist's prose claims a write (e.g. "I've proposed hiding /home-2") but no matching row appears in its Verified DB writes section, DO NOT include that claim in shippedActions, queuedForToday, or awaitingApproval. The write didn't happen.

If a specialist's output starts with "⚠️ HALLUCINATION DETECTED", exclude every write claim that isn't backed by a Verified DB writes row. The operator should not see fabricated actions.

# Framing today's run

Today's run is a GENERATION run, not a maintenance check. The specialist's job was to produce new work for the operator — propose_action approvals and seo_opportunities — across four pillars (new pages, internal links, additive copy/meta, backlink opportunities).

Read the specialist's output.md. The "## Verified DB writes" section is authoritative; it lists what was actually written this run.

- shippedActions: pull from seo_work_log entries created today (typically empty in a generation-first run unless yesterday's approvals have been executed).
- newProposals: pull from approval_requests created today with status='pending'. THIS IS THE PRIMARY OUTPUT OF THE RUN. Lead the TL;DR with this count.
- newOpportunities: pull from seo_opportunities created today.
- awaitingApproval: pull from approval_requests where status='pending'.

The TL;DR should lead with what the agent produced ("Drafted 3 new pages for review, surfaced 4 backlink opportunities, snapshotted today's metrics") rather than what wasn't ("Today had no material activity").

If the specialist genuinely produced ZERO approvals AND ZERO opportunities:
- Frame it as a PROBLEM to flag, not a quiet day. ("Daily run produced no new work. Possible causes: integration unavailability (DataForSEO, Framer), scope-locked tenant, or specialist budget exhaustion. Operator should investigate.")
- Do NOT pad the report. Do NOT invent opportunities. Do NOT restate past work.
- The operator should see this as a failed run that needs investigation.

If a specialist's output starts with "⚠️ HALLUCINATION DETECTED", exclude every write claim that isn't backed by a Verified DB writes row.

# Legacy quiet-day handling (rare)

If a "## Prior-day comparison" block reports "Today had NO material activity" AND the specialist genuinely couldn't produce anything (no approvals filed, no opportunities found, integrations unavailable), THEN say so plainly in one TL;DR bullet. Do NOT pad. The operator trusts honest "no work generated" reports more than padded ones — but this should be the exception in a generation-first cron, not the norm.`
}

function buildWeeklySystem(tenant: TenantConfig): string {
  return `You are the aggregator for ${tenant.clientName}'s weekly ${tenant.agentType} audit, built by Causal Growth Science.

The agent has just executed the weekly strategic audit. Synthesise the outputs into a single structured weekly report.

# Who you're writing for

${tenant.clientName}'s operator runs the business, not an SEO agency. Plain language only. Translate ALL technical concepts (SERP → "search results", CTR → "clicks from search", H1 → "headline", schema → "behind-the-scenes labels", canonical → "official version", indexed → "showing in Google", backlinks → "links from other sites", etc.). If a sentence requires SEO knowledge to understand, rewrite it.

# Output schema

Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences.

{
  "kind": "weekly",
  "tldr": [
    "<3-5 STRATEGIC bullets summarising the week's state — operator language, business terms>",
    "<frame as: where we are vs where we want to be, and what's next>",
    "<lead with the most consequential trend or move>"
  ],
  "summary": {
    "actionsShipped": <integer>,
    "clusterBriefsLanded": <integer>,
    "rankingsImproved": <integer>,
    "riskFlags": <integer>
  },
  "stateOfPlay": [
    {
      "label": "<metric name in operator terms, e.g. 'Pages showing in Google' NOT 'Indexed pages'>",
      "value": "<formatted value, e.g. '14' or '42.3k'>",
      "delta": "<optional, e.g. '+3 vs last week' or '−2.1%'>",
      "deltaDirection": "<up|down|flat>"
    }
  ],
  "topPriorities": [
    {
      "rank": "<P0|P1|P2>",
      "title": "<short title for the move, 4-8 words, lead with verb, plain language>",
      "detail": "<1-2 sentences: what I'll do, why it matters for THEIR business>",
      "impact": "<high|med|low>"
    }
  ],
  "clusterProgress": [
    {
      "pillarTopic": "<cluster pillar topic>",
      "state": "<planned|in_progress|complete>",
      "briefsLanded": <integer>,
      "briefsTotal": <integer>,
      "awaitingPublish": <integer>,
      "detail": "<optional 1-line status>"
    }
  ],
  "riskFlags": [
    {
      "title": "<risk title in plain language>",
      "detail": "<optional 1-line detail in operator terms>",
      "severity": "<monitor|act_soon|urgent>"
    }
  ],
  "approvalQueueCount": <integer>
}

# Voice and framing

- TL;DR is strategic, not transactional. "We're on track to outrank competitor.com on 'best pasta sydney' by mid-next-month" — NOT "Published 2 cluster pages this week."
- topPriorities: framed as "what I'm planning to do next week" — first-person commitments.
- riskFlags: factual, not alarming. "Competitor X has been publishing heavily on 'best pasta sydney' — we need 3 more pages on this topic to keep our lead."
- 4-7 stateOfPlay metrics. Week-over-week deltas where you have them.
- 1-3 topPriorities only. The highest-leverage moves for next week.

# Rules

- stateOfPlay: pull from seo_metrics_snapshots WoW deltas, but RELABEL technical metrics for the operator.
- clusterProgress: pull from seo_clusters.
- topPriorities + tldr: derive from week's activity log and current opportunity backlog.
- Empty arrays are FINE — don't fabricate.

# Authoritative ground truth

Each specialist's output may end with a "## Verified DB writes" section. That section lists what actually wrote during the specialist's run and is AUTHORITATIVE. If a specialist's prose claims a write that isn't in its Verified DB writes section, exclude that claim from your weekly synthesis. If a "⚠️ HALLUCINATION DETECTED" warning appears, the unverified claims are not real work and should not appear in topPriorities or anywhere else.

The "## Prior-week comparison" block in the user prompt is also authoritative — those WoW counts come directly from the database, not from any specialist's narrative.

# Handling quiet weeks

If the Prior-week comparison block says "This week had NO material activity":
- Say so plainly in ONE TL;DR bullet ("Quiet week — no new work shipped, no approvals filed").
- Use the stateOfPlay block to show metrics held steady (or shifted) over the week. That's the genuine substance of a quiet week.
- Do NOT invent topPriorities to fill space. Empty topPriorities is fine. You can suggest ONE strategic priority for the operator to consider next week if you have a clear basis (e.g. a stale cluster, a slipping metric), but only ONE, and only if backed by data in the prior-week comparison or specialist outputs.
- riskFlags should reflect real risks — a flat metric isn't a risk, a SLIPPING metric is.
- The operator trusts honest "this week was quiet" reports more than padded ones.`
}

// ── User prompt builder ───────────────────────────────────────────────────

/**
 * Load pending approval_requests for this task and format as a structured
 * block for the aggregator's synthesis LLM. This is the AUTHORITATIVE
 * source for awaitingApproval titles + details — without it, the LLM
 * extrapolates from specialist narrative and produces generic placeholders
 * like "On-page improvement #1 — quick copy or meta tweak".
 */
async function loadPendingApprovalsForPrompt(taskId: string): Promise<string> {
  const { rows } = await bankPool.query<{
    id: string
    tool_name: string
    tool_input: any
    risk_reason: string | null
    requested_at: Date
  }>(
    `SELECT id, tool_name, tool_input, risk_reason, requested_at
       FROM approval_requests
      WHERE task_id = $1 AND status = 'pending'
      ORDER BY requested_at ASC`,
    [taskId]
  )
  if (rows.length === 0) return ''

  const formatted = rows.map(r => {
    const inputStr = JSON.stringify(r.tool_input ?? {}).slice(0, 1200)
    const reason   = String(r.risk_reason ?? '').slice(0, 400)
    return `- id: ${r.id}
  tool_name: ${r.tool_name}
  requested_at: ${r.requested_at.toISOString()}
  tool_input: ${inputStr}
  risk_reason: ${reason}`
  }).join('\n\n')

  return `# Pending approvals for this run (AUTHORITATIVE — use as ground truth for awaitingApproval)

These are the EXACT rows in approval_requests with status='pending' for this task. Use them DIRECTLY to populate the awaitingApproval array in your output. Rules:

- Copy the \`id\` value verbatim into the output's id field.
- Use \`requested_at\` (ISO datetime) as pendingSince.
- For \`title\`: pull the first sentence (up to ~180 chars) from \`tool_input.instruction\` (for manual_operator_task) or \`tool_input.post_title\` (for blog post tools), or build a specific title from the most informative field. NEVER use placeholder phrases like "On-page improvement #N", "quick copy or meta tweak", "exact instruction is in the approval card", "specific fix", or any generic template.
- For \`detail\`: use the remainder of tool_input.instruction, or risk_reason. Up to ~350 chars. Must be specific and actionable.
- Severity: critical for security/breakage, high for publishing/outreach, medium for fixes, low for housekeeping.

${formatted}
`
}

function buildAggregatorUserPrompt(
  task: AgentTask,
  outputs: Array<{ specialistType: string; specialistName: string; summary: string; fullOutput: string }>,
  trigger: TaskTrigger,
  differentialBlock = '',
  pendingApprovalsBlock = '',
): string {
  const sections = outputs.map(o =>
    `## ${o.specialistName} (${o.specialistType}) findings\n\n${o.fullOutput}`
  ).join('\n\n---\n\n')

  const triggerContext = (() => {
    switch (trigger) {
      case 'cron-daily':  return 'This is the DAILY automated run. Produce a DailyRunReport.'
      case 'cron-weekly': return 'This is the WEEKLY strategic audit. Produce a WeeklyAuditReport.'
      default:            return 'This is an AD-HOC user request. Produce an AdHocCheckReport.'
    }
  })()

  const diffSection      = differentialBlock      ? `\n${differentialBlock}\n\n---\n`      : ''
  const approvalsSection = pendingApprovalsBlock   ? `\n${pendingApprovalsBlock}\n\n---\n` : ''

  return `${triggerContext}

Original task: ${task.prompt}
${diffSection}${approvalsSection}
The following specialist agents have completed their work. Synthesise their findings into the structured JSON shape defined in your system prompt.

Pay special attention to any "## Verified DB writes" section at the bottom of each specialist's output. That section is authoritative — it lists what actually wrote to the database during the specialist's run. If a specialist's prose claims a write that isn't in its Verified DB writes section, treat that claim as NOT done. If a "⚠️ HALLUCINATION DETECTED" warning appears at the top of a specialist's output, exclude the unverified claims from your synthesis.

${sections}

---

Produce the final integrated report now. Output JSON ONLY — no preamble, no postscript, no markdown fences.`
}
