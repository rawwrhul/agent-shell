// src/skills/seo-outcomes/index.ts
//
// Per-action outcome scoring cycle ('outcome_score' run kind).
//
// For every executed approval that targeted a specific page, measure what
// actually happened: GSC clicks/impressions/position for the target URL in
// the N days BEFORE execution vs the N days AFTER, against the rest of the
// site as a control. Verdicts are written to tenant_memory as 'win'/'loss'
// (neutral → 'learning', low confidence) with keys 'outcome-{N}d-{id8}'.
//
// The daily generation runs read these back (query_memory type='win'/'loss')
// as measured ground-truth policy: do more of what moved this site, stop
// what didn't. This closes the ship→measure→policy loop with deterministic
// numbers — no LLM anywhere in this cycle.
//
// Windows: 14d (early read) and 28d (settled read). Each (approval, window)
// is scored exactly once; the second read does not overwrite the first —
// both memories coexist and confidence reflects the window length.
//
// Source of truth for "what shipped when, targeting what": approval_requests
// (executed_at is worker-set) + tool_input (target slug/path is structural).
// NOT seo_work_log — its target_url is model-supplied and unreliable.

import { Pool } from 'pg'
import { config } from '../../config'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import { recordMemory } from '../../memory/runtime'
import { scoreOutcome, type WindowMetrics } from './scoring'

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL, max: 3 })
  return _pool
}

const WINDOWS_DAYS = [14, 28] as const
// How far back we look for unscored executions (catch-up bound).
const LOOKBACK_EXTRA_DAYS = 21

// tool_name → how to derive the target path from tool_input.
// Tools with no single target page (site schema, sitemap, ads) are skipped.
const NEW_PAGE_TOOLS = new Set(['approve_blog_pitch', 'framer_create_and_publish_blog_post'])
const SLUG_TOOLS = new Set([
  'approve_blog_pitch',
  'framer_create_and_publish_blog_post',
  'framer_update_blog_meta',
  'framer_update_blog_body',
  'framer_add_blog_alt_text',
  'framer_add_internal_link',
])

export interface OutcomeCycleResult {
  tenantId: string
  scanned:  number
  scored:   number
  wins:     number
  losses:   number
  neutral:  number
  skipped:  number
  errors:   number
}

interface ExecutedApproval {
  id:          string
  tool_name:   string
  tool_input:  Record<string, unknown>
  executed_at: Date
}

export function targetPathFor(
  toolName: string,
  toolInput: Record<string, unknown>,
  cmsPrefix: string,
): string | null {
  if (SLUG_TOOLS.has(toolName)) {
    const slug = typeof toolInput.slug === 'string' ? toolInput.slug.trim().replace(/^\/+|\/+$/g, '') : ''
    if (!slug) return null
    const prefix = cmsPrefix.endsWith('/') ? cmsPrefix : `${cmsPrefix}/`
    return `${prefix}${slug}`
  }
  if (toolName === 'framer_update_marketing_page_text') {
    const p = typeof toolInput.pagePath === 'string' ? toolInput.pagePath.trim() : ''
    if (!p || p === '/') return null
    return p.startsWith('/') ? p : `/${p}`
  }
  return null
}

async function windowMetrics(
  db: Pool, tenantId: string, path: string | null, from: Date, to: Date, invert: boolean,
): Promise<WindowMetrics> {
  // Suffix match: LIKE '%<path>' only matches URLs ENDING in the path, so
  // '/resources/a' does not collide with '/resources/abc'. Trailing-slash
  // variant included. invert=true → the control (everything except the page).
  const cond = invert
    ? `AND page_url NOT LIKE '%' || $2 AND page_url NOT LIKE '%' || $2 || '/'`
    : `AND (page_url LIKE '%' || $2 OR page_url LIKE '%' || $2 || '/')`
  const { rows } = await db.query<{ clicks: string | null; impressions: string | null; pos: string | null }>(
    `SELECT COALESCE(SUM(clicks), 0)      AS clicks,
            COALESCE(SUM(impressions), 0) AS impressions,
            CASE WHEN SUM(impressions) > 0
                 THEN SUM(position * impressions) / SUM(impressions)
            END AS pos
       FROM ranking_history
      WHERE tenant_id = $1 ${cond}
        AND date >= $3::date AND date < $4::date`,
    [tenantId, path ?? '', from, to],
  )
  const r = rows[0]
  return {
    clicks:      Number(r?.clicks ?? 0),
    impressions: Number(r?.impressions ?? 0),
    position:    r?.pos !== null && r?.pos !== undefined ? Number(r.pos) : null,
  }
}

async function alreadyScored(db: Pool, tenantId: string, key: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM tenant_memory WHERE tenant_id = $1 AND key = $2 LIMIT 1`,
    [tenantId, key],
  )
  return rows.length > 0
}

export async function runOutcomeScoreCycle(tenantId: string): Promise<OutcomeCycleResult> {
  const result: OutcomeCycleResult = {
    tenantId, scanned: 0, scored: 0, wins: 0, losses: 0, neutral: 0, skipped: 0, errors: 0,
  }
  const db = pool()

  const tenant = await getTenant(tenantId).catch(() => null)
  if (!tenant) {
    logger.warn('outcome_cycle_tenant_missing', { tenantId })
    return result
  }
  const cmsPrefix = tenant.cmsPathPrefixes?.[0] ?? '/resources/'

  for (const windowDays of WINDOWS_DAYS) {
    const now = Date.now()
    const newestEligible = new Date(now - windowDays * 86400_000)
    const oldestEligible = new Date(now - (windowDays + LOOKBACK_EXTRA_DAYS) * 86400_000)

    const { rows } = await db.query<ExecutedApproval>(
      `SELECT id, tool_name, tool_input, executed_at
         FROM approval_requests
        WHERE tenant_id = $1
          AND status = 'approved'
          AND executed_at IS NOT NULL
          AND executed_outcome LIKE 'success%'
          AND executed_at >= $2 AND executed_at <= $3
        ORDER BY executed_at ASC`,
      [tenantId, oldestEligible, newestEligible],
    )

    for (const approval of rows) {
      result.scanned++
      try {
        const key = `outcome-${windowDays}d-${approval.id.slice(0, 8)}`
        if (await alreadyScored(db, tenantId, key)) { result.skipped++; continue }

        const path = targetPathFor(approval.tool_name, approval.tool_input ?? {}, cmsPrefix)
        if (!path) { result.skipped++; continue }

        const executedAt = new Date(approval.executed_at)
        const beforeFrom = new Date(executedAt.getTime() - windowDays * 86400_000)
        const afterTo    = new Date(executedAt.getTime() + windowDays * 86400_000)

        const [pageBefore, pageAfter, controlBefore, controlAfter] = await Promise.all([
          windowMetrics(db, tenantId, path, beforeFrom, executedAt, false),
          windowMetrics(db, tenantId, path, executedAt, afterTo, false),
          windowMetrics(db, tenantId, path, beforeFrom, executedAt, true),
          windowMetrics(db, tenantId, path, executedAt, afterTo, true),
        ])

        const score = scoreOutcome({
          pageBefore, pageAfter, controlBefore, controlAfter,
          isNewPage: NEW_PAGE_TOOLS.has(approval.tool_name),
        })

        const dateStr = executedAt.toISOString().slice(0, 10)
        const verdictWord = score.verdict.toUpperCase()
        await recordMemory({
          tenantId,
          type:       score.verdict === 'neutral' ? 'learning' : score.verdict,
          key,
          value:      `[Measured outcome +${windowDays}d] ${approval.tool_name} on ${path} (shipped ${dateStr}): ${score.reason}. ${verdictWord}.`,
          confidence: score.verdict === 'neutral' ? 0.4 : (windowDays >= 28 ? 0.8 : 0.65),
        })

        result.scored++
        if (score.verdict === 'win') result.wins++
        else if (score.verdict === 'loss') result.losses++
        else result.neutral++
      } catch (err) {
        result.errors++
        logger.warn('outcome_cycle_action_failed', {
          tenantId, approvalId: approval.id, err: String(err).slice(0, 200),
        })
      }
    }
  }

  logger.info('outcome_cycle_completed', { ...result })
  return result
}
