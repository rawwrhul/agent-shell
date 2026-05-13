// src/orchestrator/cron-context.ts
//
// Differential context loaders for daily and weekly cron reports.
//
// Why this exists:
//   Before this module, the aggregator's daily and weekly prompts pulled
//   from seo_work_log / seo_opportunities / seo_metrics_snapshots but
//   had no prior-window comparison. A quiet day got the same "shipped
//   overnight" framing as a busy day. A no-change week got a padded
//   weekly report.
//
// What this module does:
//   - loadDailyDifferential: counts of approvals / work-log / opportunities
//     created in the last 24h vs the 24h before that.
//   - loadWeeklyDifferential: counts and metric deltas for the last 7d
//     vs the prior 7d, plus the most recent and prior-week metric
//     snapshot rows for week-over-week comparison.
//
// Output is injected into the aggregator's USER prompt (not system) so
// it changes per run and stays uncached. The aggregator's system
// prompt is updated separately to instruct on "no material change"
// handling.
//
// Schema note for seo_metrics_snapshots:
//   The table uses named columns (indexed_pages, ranking_keywords,
//   schema_coverage_pct, avg_position, ai_citations_estimated,
//   domain_rating), not a generic metric_name/value shape. WoW deltas
//   are computed across these columns.

import { pool } from '../memory/postgres'
import { logger } from '../logger'

// ── Types ─────────────────────────────────────────────────────────────────

export interface DailyDifferential {
  /** True if this is the tenant's first daily run (no prior window data). */
  firstRun: boolean
  /** Last 24h activity. */
  today: {
    approvalRequestsCreated:  number
    approvalRequestsResolved: number
    workLogEntries:           number
    opportunitiesSurfaced:    number
  }
  /** The 24h before that. */
  yesterday: {
    approvalRequestsCreated:  number
    approvalRequestsResolved: number
    workLogEntries:           number
    opportunitiesSurfaced:    number
  }
  /** Convenience deltas: today minus yesterday. */
  delta: {
    approvalRequestsCreated:  number
    approvalRequestsResolved: number
    workLogEntries:           number
    opportunitiesSurfaced:    number
  }
  /** Was there ANY activity today? Used by the prompt to decide "no change". */
  materialActivityToday: boolean
}

export interface MetricsSnapshotRow {
  capturedAt:           Date
  indexedPages:         number | null
  rankingKeywords:      number | null
  schemaCoveragePct:    number | null
  avgPosition:          number | null
  aiCitationsEstimated: number | null
  domainRating:         number | null
}

export interface WeeklyDifferential {
  firstRun: boolean
  thisWeek: {
    approvalRequestsCreated: number
    workLogEntries:          number
    opportunitiesSurfaced:   number
    clustersUpdated:         number
  }
  priorWeek: {
    approvalRequestsCreated: number
    workLogEntries:          number
    opportunitiesSurfaced:   number
    clustersUpdated:         number
  }
  delta: {
    approvalRequestsCreated: number
    workLogEntries:          number
    opportunitiesSurfaced:   number
    clustersUpdated:         number
  }
  materialActivityThisWeek: boolean
  /** Most recent metrics snapshot in this week. */
  latestSnapshot: MetricsSnapshotRow | null
  /** Most recent metrics snapshot from the prior week (for WoW deltas). */
  priorWeekSnapshot: MetricsSnapshotRow | null
}

// ── Daily ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

export async function loadDailyDifferential(
  tenantId: string,
  now: Date = new Date(),
): Promise<DailyDifferential> {
  const todayStart     = new Date(now.getTime() - DAY_MS)
  const yesterdayStart = new Date(now.getTime() - 2 * DAY_MS)

  try {
    const [
      todayApprovals,    ydayApprovals,
      todayResolved,     ydayResolved,
      todayWork,         ydayWork,
      todayOpps,         ydayOpps,
    ] = await Promise.all([
      countSince('approval_requests', 'requested_at', tenantId, todayStart, now),
      countSince('approval_requests', 'requested_at', tenantId, yesterdayStart, todayStart),
      countSince('approval_requests', 'resolved_at',  tenantId, todayStart, now,
                 "status IN ('approved','rejected')"),
      countSince('approval_requests', 'resolved_at',  tenantId, yesterdayStart, todayStart,
                 "status IN ('approved','rejected')"),
      countSince('seo_work_log',      'executed_at',  tenantId, todayStart, now),
      countSince('seo_work_log',      'executed_at',  tenantId, yesterdayStart, todayStart),
      countSince('seo_opportunities', 'created_at',   tenantId, todayStart, now),
      countSince('seo_opportunities', 'created_at',   tenantId, yesterdayStart, todayStart),
    ])

    const today = {
      approvalRequestsCreated:  todayApprovals,
      approvalRequestsResolved: todayResolved,
      workLogEntries:           todayWork,
      opportunitiesSurfaced:    todayOpps,
    }
    const yesterday = {
      approvalRequestsCreated:  ydayApprovals,
      approvalRequestsResolved: ydayResolved,
      workLogEntries:           ydayWork,
      opportunitiesSurfaced:    ydayOpps,
    }
    const delta = {
      approvalRequestsCreated:  today.approvalRequestsCreated  - yesterday.approvalRequestsCreated,
      approvalRequestsResolved: today.approvalRequestsResolved - yesterday.approvalRequestsResolved,
      workLogEntries:           today.workLogEntries           - yesterday.workLogEntries,
      opportunitiesSurfaced:    today.opportunitiesSurfaced    - yesterday.opportunitiesSurfaced,
    }

    const materialActivityToday =
      today.approvalRequestsCreated > 0 ||
      today.approvalRequestsResolved > 0 ||
      today.workLogEntries > 0 ||
      today.opportunitiesSurfaced > 0

    const firstRun =
      yesterday.approvalRequestsCreated === 0 &&
      yesterday.workLogEntries === 0 &&
      yesterday.opportunitiesSurfaced === 0 &&
      today.approvalRequestsCreated === 0 &&
      today.workLogEntries === 0

    return { firstRun, today, yesterday, delta, materialActivityToday }
  } catch (err) {
    logger.warn('cron_daily_differential_load_failed', {
      tenantId, err: String(err).slice(0, 200),
    })
    return emptyDaily()
  }
}

function emptyDaily(): DailyDifferential {
  const zero = {
    approvalRequestsCreated:  0,
    approvalRequestsResolved: 0,
    workLogEntries:           0,
    opportunitiesSurfaced:    0,
  }
  return {
    firstRun: true,
    today: zero,
    yesterday: zero,
    delta: zero,
    materialActivityToday: false,
  }
}

// ── Weekly ────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * DAY_MS

export async function loadWeeklyDifferential(
  tenantId: string,
  now: Date = new Date(),
): Promise<WeeklyDifferential> {
  const thisWeekStart  = new Date(now.getTime() - WEEK_MS)
  const priorWeekStart = new Date(now.getTime() - 2 * WEEK_MS)

  try {
    const [
      thisApprovals, priorApprovals,
      thisWork,      priorWork,
      thisOpps,      priorOpps,
      thisClusters,  priorClusters,
      latestSnap,    priorSnap,
    ] = await Promise.all([
      countSince('approval_requests', 'requested_at', tenantId, thisWeekStart, now),
      countSince('approval_requests', 'requested_at', tenantId, priorWeekStart, thisWeekStart),
      countSince('seo_work_log',      'executed_at',  tenantId, thisWeekStart, now),
      countSince('seo_work_log',      'executed_at',  tenantId, priorWeekStart, thisWeekStart),
      countSince('seo_opportunities', 'created_at',   tenantId, thisWeekStart, now),
      countSince('seo_opportunities', 'created_at',   tenantId, priorWeekStart, thisWeekStart),
      countSince('seo_clusters',      'updated_at',   tenantId, thisWeekStart, now),
      countSince('seo_clusters',      'updated_at',   tenantId, priorWeekStart, thisWeekStart),
      latestSnapshot(tenantId, thisWeekStart, now),
      latestSnapshot(tenantId, priorWeekStart, thisWeekStart),
    ])

    const thisWeek = {
      approvalRequestsCreated: thisApprovals,
      workLogEntries:          thisWork,
      opportunitiesSurfaced:   thisOpps,
      clustersUpdated:         thisClusters,
    }
    const priorWeek = {
      approvalRequestsCreated: priorApprovals,
      workLogEntries:          priorWork,
      opportunitiesSurfaced:   priorOpps,
      clustersUpdated:         priorClusters,
    }
    const delta = {
      approvalRequestsCreated: thisWeek.approvalRequestsCreated - priorWeek.approvalRequestsCreated,
      workLogEntries:          thisWeek.workLogEntries          - priorWeek.workLogEntries,
      opportunitiesSurfaced:   thisWeek.opportunitiesSurfaced   - priorWeek.opportunitiesSurfaced,
      clustersUpdated:         thisWeek.clustersUpdated         - priorWeek.clustersUpdated,
    }

    const materialActivityThisWeek =
      thisWeek.approvalRequestsCreated > 0 ||
      thisWeek.workLogEntries > 0 ||
      thisWeek.opportunitiesSurfaced > 0 ||
      thisWeek.clustersUpdated > 0

    const firstRun =
      priorWeek.approvalRequestsCreated === 0 &&
      priorWeek.workLogEntries === 0 &&
      priorWeek.opportunitiesSurfaced === 0 &&
      priorSnap === null

    return {
      firstRun, thisWeek, priorWeek, delta, materialActivityThisWeek,
      latestSnapshot:    latestSnap,
      priorWeekSnapshot: priorSnap,
    }
  } catch (err) {
    logger.warn('cron_weekly_differential_load_failed', {
      tenantId, err: String(err).slice(0, 200),
    })
    return emptyWeekly()
  }
}

function emptyWeekly(): WeeklyDifferential {
  const zero = {
    approvalRequestsCreated: 0,
    workLogEntries:          0,
    opportunitiesSurfaced:   0,
    clustersUpdated:         0,
  }
  return {
    firstRun: true,
    thisWeek: zero,
    priorWeek: zero,
    delta: zero,
    materialActivityThisWeek: false,
    latestSnapshot: null,
    priorWeekSnapshot: null,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function countSince(
  table: string,
  timeCol: string,
  tenantId: string,
  start: Date,
  end: Date,
  extraWhere?: string,
): Promise<number> {
  try {
    const where = extraWhere ? `AND ${extraWhere}` : ''
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM ${table}
       WHERE tenant_id=$1 AND ${timeCol} >= $2 AND ${timeCol} < $3 ${where}`,
      [tenantId, start, end],
    )
    return parseInt(r.rows[0]?.c ?? '0', 10)
  } catch (err) {
    // Some tables may have nullable time columns (e.g. resolved_at).
    // Don't fail the whole differential just because one count failed.
    logger.warn('cron_count_failed', {
      table, timeCol, tenantId, err: String(err).slice(0, 200),
    })
    return 0
  }
}

async function latestSnapshot(
  tenantId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<MetricsSnapshotRow | null> {
  try {
    const r = await pool.query<{
      captured_at:               Date
      indexed_pages:             number | null
      ranking_keywords:          number | null
      schema_coverage_pct:       string | null
      avg_position:              string | null
      ai_citations_estimated:    number | null
      domain_rating:             number | null
    }>(
      `SELECT captured_at, indexed_pages, ranking_keywords, schema_coverage_pct,
              avg_position, ai_citations_estimated, domain_rating
       FROM seo_metrics_snapshots
       WHERE tenant_id=$1 AND captured_at >= $2 AND captured_at < $3
       ORDER BY captured_at DESC
       LIMIT 1`,
      [tenantId, windowStart, windowEnd],
    )
    const row = r.rows[0]
    if (!row) return null
    return {
      capturedAt:           row.captured_at,
      indexedPages:         row.indexed_pages,
      rankingKeywords:      row.ranking_keywords,
      schemaCoveragePct:    row.schema_coverage_pct === null ? null : Number(row.schema_coverage_pct),
      avgPosition:          row.avg_position       === null ? null : Number(row.avg_position),
      aiCitationsEstimated: row.ai_citations_estimated,
      domainRating:         row.domain_rating,
    }
  } catch (err) {
    logger.warn('cron_latest_snapshot_failed', { tenantId, err: String(err).slice(0, 200) })
    return null
  }
}

// ── Prompt formatting helpers ─────────────────────────────────────────────

/**
 * Render a DailyDifferential block for injection into the aggregator's
 * USER prompt. Plain text, scan-readable; lets the model frame the day
 * as quiet, busy, or routine without inventing numbers.
 */
export function formatDailyDifferentialForPrompt(diff: DailyDifferential): string {
  if (diff.firstRun) {
    return [
      '## Prior-day comparison',
      'This appears to be the first daily run for this tenant. No prior-day data to compare against.',
      'Frame the report as a baseline establishment, not a delta.',
    ].join('\n')
  }

  return [
    '## Prior-day comparison',
    `Today (last 24h):     ${diff.today.approvalRequestsCreated} new approvals, ${diff.today.approvalRequestsResolved} resolved, ${diff.today.workLogEntries} work-log entries, ${diff.today.opportunitiesSurfaced} new opportunities.`,
    `Yesterday (24-48h):   ${diff.yesterday.approvalRequestsCreated} new approvals, ${diff.yesterday.approvalRequestsResolved} resolved, ${diff.yesterday.workLogEntries} work-log entries, ${diff.yesterday.opportunitiesSurfaced} new opportunities.`,
    diff.materialActivityToday
      ? 'Today had material activity. Report it as part of today\'s output (e.g. proposals filed, shipped actions, opportunities surfaced).'
      : 'Today is a clean canvas — no prior approvals, no recent work-log entries. Your job is to FILL it: produce 2-5 propose_action calls and 3-5 seo_opportunities across the four pillars (new pages, internal links, additive copy/meta, backlinks). A truly zero-output run is a failure to flag, not a quiet day to accept.',
  ].join('\n')
}

/**
 * Render a WeeklyDifferential block including WoW metric deltas across
 * the fixed columns on seo_metrics_snapshots.
 */
export function formatWeeklyDifferentialForPrompt(diff: WeeklyDifferential): string {
  if (diff.firstRun) {
    return [
      '## Prior-week comparison',
      'This appears to be the first weekly run for this tenant. No prior-week data to compare against.',
      'Frame the report as a baseline.',
    ].join('\n')
  }

  const snapshotLines = buildSnapshotDeltaLines(diff.latestSnapshot, diff.priorWeekSnapshot)

  return [
    '## Prior-week comparison',
    `This week:  ${diff.thisWeek.approvalRequestsCreated} approvals filed, ${diff.thisWeek.workLogEntries} work-log entries, ${diff.thisWeek.opportunitiesSurfaced} opportunities, ${diff.thisWeek.clustersUpdated} clusters updated.`,
    `Prior week: ${diff.priorWeek.approvalRequestsCreated} approvals filed, ${diff.priorWeek.workLogEntries} work-log entries, ${diff.priorWeek.opportunitiesSurfaced} opportunities, ${diff.priorWeek.clustersUpdated} clusters updated.`,
    '',
    '### Metric snapshots (WoW deltas)',
    ...snapshotLines,
    '',
    diff.materialActivityThisWeek
      ? 'This week had material activity. Report deltas and trends.'
      : 'This week had NO material activity. Say so plainly. Do not invent priorities to fill space.',
  ].join('\n')
}

function buildSnapshotDeltaLines(
  latest: MetricsSnapshotRow | null,
  prior:  MetricsSnapshotRow | null,
): string[] {
  if (!latest) return ['- No metrics snapshotted this week.']
  if (!prior)  return [
    `- Latest snapshot (${formatDate(latest.capturedAt)}): ${formatSnapshotInline(latest)}`,
    '- No prior-week snapshot to compare against.',
  ]

  const lines: string[] = []
  pushMetric(lines, 'Indexed pages',           latest.indexedPages,         prior.indexedPages)
  pushMetric(lines, 'Ranking keywords',        latest.rankingKeywords,      prior.rankingKeywords)
  pushMetric(lines, 'Schema coverage (%)',     latest.schemaCoveragePct,    prior.schemaCoveragePct, 1)
  pushMetric(lines, 'Avg position',            latest.avgPosition,          prior.avgPosition, 2, true)
  pushMetric(lines, 'AI citations (estimated)', latest.aiCitationsEstimated, prior.aiCitationsEstimated)
  pushMetric(lines, 'Domain rating',           latest.domainRating,         prior.domainRating)

  return lines.length ? lines : ['- No common metrics snapshotted in both weeks.']
}

function pushMetric(
  out: string[],
  label: string,
  latest: number | null,
  prior: number | null,
  decimals = 0,
  lowerIsBetter = false,
): void {
  if (latest === null && prior === null) return
  if (latest === null) {
    out.push(`- ${label}: (no current snapshot, prior was ${prior!.toFixed(decimals)})`)
    return
  }
  if (prior === null) {
    out.push(`- ${label}: ${latest.toFixed(decimals)} (no prior baseline)`)
    return
  }
  const diff = latest - prior
  const sign = diff > 0 ? '+' : ''
  const dir  = diff === 0 ? 'flat' : (lowerIsBetter ? (diff < 0 ? 'better' : 'worse') : (diff > 0 ? 'better' : 'worse'))
  out.push(`- ${label}: ${latest.toFixed(decimals)} (${sign}${diff.toFixed(decimals)} WoW, ${dir})`)
}

function formatSnapshotInline(s: MetricsSnapshotRow): string {
  const parts: string[] = []
  if (s.indexedPages    !== null) parts.push(`${s.indexedPages} indexed`)
  if (s.rankingKeywords !== null) parts.push(`${s.rankingKeywords} ranking`)
  if (s.avgPosition     !== null) parts.push(`avg pos ${s.avgPosition.toFixed(1)}`)
  return parts.join(', ') || '(no numeric data)'
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
