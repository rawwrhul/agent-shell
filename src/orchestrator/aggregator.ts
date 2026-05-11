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

    // Single Claude call to synthesise — system prompt picked by trigger.
    const systemPrompt = getAggregatorSystemPromptFor(trigger, tenant)
    const userPrompt = buildAggregatorUserPrompt(task, outputs, trigger)

    const response = await anthropic.messages.create({
      model:      tenant.agentModel,
      max_tokens: 8096,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    })

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')

    // Persist raw output for debugging regardless of parse outcome.
    const reportPath = path.resolve(config.PROGRESS_DIR, task.id, 'final-report.md')
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, rawText, 'utf-8')

    // Attempt structured parse. On failure, hand the raw string to the
    // presenter so the legacy summary path renders rather than failing.
    const parsed = parseAggregatorOutput(rawText, trigger, task, tenant)

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
    logger.error('aggregator_failed', { taskId: task.id, err: String(err) })
    await presenter.failRun(task.id, String(err).slice(0, 400))
    await endTrace(sessionId, 'error')
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
    case 'cron-daily':  return 'daily'
    case 'cron-weekly': return 'weekly'
    default:            return 'ad_hoc'
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

function buildAdHocSystem(tenant: TenantConfig): string {
  return `You are the aggregator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.

You have just received the outputs of one or more specialist subagents who worked on a user's ad-hoc request. Synthesise their findings into a single structured report.

Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences. No explanation. JSON only.

{
  "kind": "ad_hoc",
  "title": "<short title for the run, e.g. 'Homepage check', 'Schema audit', 'Crawl errors review'>",
  "subtitle": "<optional one-line context: domain · scope · notable scope detail>",
  "tldr": [
    "<3-5 bullet points, each one outcome-focused, plain prose, no markdown>",
    "<each bullet 8-25 words, scan-readable on mobile>",
    "<lead with the most important finding>"
  ],
  "broken": [
    {
      "severity": "<critical|high|medium|low>",
      "priority": "<P0|P1|P2|P3>",
      "text": "<the issue, action-oriented: 'X is missing' / 'X is broken' / 'X is misconfigured'>",
      "meta": "<optional right-aligned annotation, e.g. '3 pages' or 'P0'>"
    }
  ],
  "working": [
    "<things that are working well, one line each, lead with the noun>"
  ],
  "leverage": [
    {
      "priority": "<P0|P1|P2|P3>",
      "title": "<short action title, 4-8 words>",
      "detail": "<1-2 sentences: what I'll do, why it matters>",
      "estImpact": "<short impact estimate, e.g. '+15% est. CTR' or '3x indexable surface'>"
    }
  ]
}

Voice and framing:
- Write as "what I'm planning to do" — first-person commitments, not directives.
  YES: "Restructure /menu schema to JSON-LD" / "I'll add FAQPage markup to /pricing"
  NO:  "You should restructure schema" / "Recommend that you add FAQ markup"
- Active voice. Lead with verbs and nouns, not adjectives.
- Outcome-focused. "FAQ schema would lift CTR ~12%" not "We recommend implementing FAQ schema".
- No padding. Cut every word that doesn't carry information.

Rules:
- TL;DR is mandatory: 3-5 bullets, scan-readable on mobile.
- "broken" array: severity + priority required. Order by severity desc, then priority asc.
- "working" array can be empty (don't fabricate positives if there aren't any).
- "leverage" array: 1-3 items only. The HIGHEST-leverage moves, not every recommendation.
- If a specialist reports something that's observation-only (no action attached), exclude it.
- Use plain prose, not markdown formatting. The Slack renderer handles emphasis.
- Numbers and percentages where you have them — don't invent them.`
}

function buildDailySystem(tenant: TenantConfig): string {
  return `You are the aggregator for ${tenant.clientName}'s daily ${tenant.agentType} run, built by Causal Growth Science.

The agent has just executed the daily SEO loop. Synthesise the outputs into a single structured daily report.

Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences.

{
  "kind": "daily",
  "tldr": [
    "<3-5 bullets summarising overnight shipped + queued + awaiting approval state>",
    "<lead with the most consequential outcome of the day>",
    "<one bullet on what needs the operator's attention>"
  ],
  "shippedActions": [
    {
      "id": "<UUID from seo_work_log if available, else generate one>",
      "title": "<what shipped, lead with verb: 'Added FAQPage schema to /pricing'>",
      "detail": "<optional 1-line context or impact>",
      "executedAt": "<ISO datetime>",
      "status": "<success|partial>"
    }
  ],
  "newOpportunities": [
    {
      "id": "<UUID if available, else generate>",
      "description": "<opportunity, outcome-focused>",
      "priority": "<P0|P1|P2>"
    }
  ],
  "queuedForToday": [
    {
      "id": "<UUID>",
      "title": "<what's queued, verb-led>",
      "estimateMinutes": <integer or null>
    }
  ],
  "awaitingApproval": [
    {
      "id": "<approval_requests.id UUID>",
      "title": "<short title>",
      "detail": "<1-line context>",
      "pendingSince": "<ISO datetime>",
      "severity": "<critical|high|medium|low>",
      "approvalUrl": "<optional Sheets deeplink>"
    }
  ]
}

Voice and framing:
- "Shipped overnight" framing for shippedActions — past tense, factual.
- "I'm planning to ship" framing for queuedForToday — first-person commitment.
- "Needs your call" framing for awaitingApproval — operator-respectful.
- Strategic, not transactional. TL;DR should contextualise, not just list.

Rules:
- Pull "shippedActions" from seo_work_log entries created in this run.
- Pull "newOpportunities" from new seo_opportunities (status='open', created in this run).
- Pull "queuedForToday" from seo_opportunities with priority=P0/P1 not yet shipped.
- Pull "awaitingApproval" from approval_requests where status='pending' and (defer_until IS NULL OR defer_until < now()).
- Empty arrays are FINE if nothing fits the bucket — don't fabricate to fill space.
- TL;DR doesn't repeat what's in the lists below — it summarises and contextualises.`
}

function buildWeeklySystem(tenant: TenantConfig): string {
  return `You are the aggregator for ${tenant.clientName}'s weekly ${tenant.agentType} audit, built by Causal Growth Science.

The agent has just executed the weekly strategic audit. Synthesise the outputs into a single structured weekly report.

Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences.

{
  "kind": "weekly",
  "tldr": [
    "<3-5 STRATEGIC bullets summarising the week's state, not transactional details>",
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
      "label": "<metric name, e.g. 'Indexed pages'>",
      "value": "<formatted value, e.g. '14' or '42.3k'>",
      "delta": "<optional, e.g. '+3 vs last wk' or '−2.1%'>",
      "deltaDirection": "<up|down|flat>"
    }
  ],
  "topPriorities": [
    {
      "rank": "<P0|P1|P2>",
      "title": "<short title for the move, 4-8 words>",
      "detail": "<1-2 sentences: what I'll do, why it matters>",
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
      "title": "<risk title>",
      "detail": "<optional 1-line detail>",
      "severity": "<monitor|act_soon|urgent>"
    }
  ],
  "approvalQueueCount": <integer>
}

Voice and framing:
- TL;DR is strategic, not transactional. "Cluster X reached 8/12 pages and is on-track to compete with competitor.com on /topic" — NOT "Published 2 pages this week."
- topPriorities: framed as "what I'm planning to do next week" — first-person commitments, not directives.
- riskFlags: factual, not alarming. "Competitor X published 4 long-form pieces on /topic; our /topic cluster needs to land 3 more pages this fortnight to stay ahead."
- 4-7 stateOfPlay metrics. WoW deltas where you have them.
- 1-3 topPriorities only. The highest-leverage moves for next week.

Rules:
- stateOfPlay: pull from seo_metrics_snapshots WoW deltas.
- clusterProgress: pull from seo_clusters.
- topPriorities + tldr: derive from week's activity log and current opportunity backlog.
- Empty arrays are FINE — don't fabricate.`
}

// ── User prompt builder ───────────────────────────────────────────────────

function buildAggregatorUserPrompt(
  task: AgentTask,
  outputs: Array<{ specialistType: string; specialistName: string; summary: string; fullOutput: string }>,
  trigger: TaskTrigger,
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

  return `${triggerContext}

Original task: ${task.prompt}

The following specialist agents have completed their work. Synthesise their findings into the structured JSON shape defined in your system prompt.

${sections}

---

Produce the final integrated report now. Output JSON ONLY — no preamble, no postscript, no markdown fences.`
}
