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
      // Cache the system prompt — it's deterministic per (trigger, tenant)
      // pair, so daily/weekly cron runs hit the cache reliably. Specialist
      // outputs (in messages) vary per run and stay uncached.
      system:     cachedSystem(systemPrompt),
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
  return `You are the aggregator for ${tenant.clientName}'s daily ${tenant.agentType} run, built by Causal Growth Science.

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
- TL;DR doesn't repeat the lists — it summarises and contextualises.`
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
