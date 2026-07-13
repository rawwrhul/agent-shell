// src/skills/daily-digest/index.ts
//
// 'daily_digest' cycle — silent, deterministic, DB-only. Gathers the last
// 24 hours of shipped work (with production links), article publishes and
// quality-gate discards, pending human items, today's measured outcome
// verdicts, and a 7d-vs-prior-7d GSC summary, then upserts ONE row into
// daily_digests (structured payload JSONB + rendered markdown).
//
// Deliberately does NOT send anything anywhere — no Slack, no email. It's
// the persisted daily record for dashboards / client reporting to read.

import { Pool } from 'pg'
import { config } from '../../config'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import {
  buildDigestMarkdown, productionUrlFor,
  type DigestPayload, type DigestAction, type DigestArticle,
  type DigestMetricsWindow, type DigestMover,
} from './build'

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL, max: 3 })
  return _pool
}

export interface DigestCycleResult {
  tenantId:   string
  digestDate: string
  actions:    number
  articles:   number
  written:    boolean
}

async function metricsWindow(db: Pool, tenantId: string, fromDaysAgo: number, toDaysAgo: number): Promise<DigestMetricsWindow> {
  const { rows } = await db.query<{ clicks: string; impressions: string; pos: string | null }>(
    `SELECT COALESCE(SUM(clicks), 0) AS clicks,
            COALESCE(SUM(impressions), 0) AS impressions,
            CASE WHEN SUM(impressions) > 0
                 THEN SUM(position * impressions) / SUM(impressions) END AS pos
       FROM ranking_history
      WHERE tenant_id = $1
        AND date >= NOW()::date - $2::int
        AND date <  NOW()::date - $3::int`,
    [tenantId, fromDaysAgo, toDaysAgo],
  )
  const r = rows[0]
  return {
    clicks:      Number(r?.clicks ?? 0),
    impressions: Number(r?.impressions ?? 0),
    position:    r?.pos !== null && r?.pos !== undefined ? Number(r.pos) : null,
  }
}

export async function runDailyDigestCycle(tenantId: string): Promise<DigestCycleResult> {
  const db = pool()
  const digestDate = new Date().toISOString().slice(0, 10)
  const result: DigestCycleResult = { tenantId, digestDate, actions: 0, articles: 0, written: false }

  const tenant = await getTenant(tenantId).catch(() => null)
  if (!tenant) {
    logger.warn('daily_digest_tenant_missing', { tenantId })
    return result
  }
  const cmsPrefix = tenant.cmsPathPrefixes?.[0] ?? '/resources/'

  // ── Executed actions, last 24h ────────────────────────────────────────
  const { rows: actionRows } = await db.query<{
    tool_name: string; proposed_action: string | null; tool_input: Record<string, unknown>
    executed_at: Date; executed_outcome: string | null; resolved_by: string | null
  }>(
    `SELECT tool_name, proposed_action, tool_input, executed_at, executed_outcome, resolved_by
       FROM approval_requests
      WHERE tenant_id = $1 AND executed_at >= NOW() - interval '24 hours'
      ORDER BY executed_at ASC`,
    [tenantId],
  )

  const actions: DigestAction[] = actionRows.map(r => ({
    toolName:       r.tool_name,
    proposedAction: r.proposed_action,
    executedAt:     new Date(r.executed_at).toISOString(),
    outcome:        (r.executed_outcome ?? '').startsWith('success') ? 'success' : 'failed',
    resolvedBy:     r.resolved_by,
    autonomous:     r.resolved_by === '_autonomous_',
    url:            productionUrlFor(r.tool_name, r.tool_input ?? {}, tenant.targetDomain, cmsPrefix),
  }))

  const articles: DigestArticle[] = actionRows
    .filter(r => (r.tool_name === 'framer_confirm_publish' || r.tool_name === 'webflow_confirm_publish')
              && (r.executed_outcome ?? '').startsWith('success'))
    .map(r => {
      const ti = r.tool_input ?? {}
      const slug = typeof ti.slug === 'string' ? ti.slug : ''
      return {
        title: typeof ti.title === 'string' ? ti.title : null,
        slug,
        url: productionUrlFor(r.tool_name, ti, tenant.targetDomain, cmsPrefix) ?? slug,
      }
    })
    .filter(a => a.slug)

  // ── Pending human items ───────────────────────────────────────────────
  const { rows: pendingRows } = await db.query<{ tool_name: string; proposed_action: string | null }>(
    `SELECT tool_name, proposed_action FROM approval_requests
      WHERE tenant_id = $1 AND status = 'pending'
      ORDER BY requested_at DESC LIMIT 10`,
    [tenantId],
  )

  // ── Quality-gate discards + outcome verdicts, last 24h ───────────────
  const { rows: memRows } = await db.query<{ type: string; key: string; value: string }>(
    `SELECT type, key, value FROM tenant_memory
      WHERE tenant_id = $1 AND updated_at >= NOW() - interval '24 hours'
        AND (key LIKE 'publish-failed-%' OR key LIKE 'outcome-%')`,
    [tenantId],
  )
  const discards = memRows
    .filter(m => m.key.startsWith('publish-failed-'))
    .map(m => ({ key: m.key, value: m.value }))
  const outcomeRows = memRows.filter(m => m.key.startsWith('outcome-'))
  const outcomes = {
    wins:    outcomeRows.filter(m => m.type === 'win').length,
    losses:  outcomeRows.filter(m => m.type === 'loss').length,
    neutral: outcomeRows.filter(m => m.type === 'learning').length,
    samples: outcomeRows.filter(m => m.type !== 'learning').slice(0, 5).map(m => m.value),
  }

  // ── GSC summary: last 7 full days vs prior 7 ─────────────────────────
  const [last7, prior7] = await Promise.all([
    metricsWindow(db, tenantId, 7, 0),
    metricsWindow(db, tenantId, 14, 7),
  ])
  const { rows: moverRows } = await db.query<{ page_url: string; last7: string; prior7: string }>(
    `SELECT page_url,
            COALESCE(SUM(clicks) FILTER (WHERE date >= NOW()::date - 7), 0)  AS last7,
            COALESCE(SUM(clicks) FILTER (WHERE date <  NOW()::date - 7), 0)  AS prior7
       FROM ranking_history
      WHERE tenant_id = $1 AND date >= NOW()::date - 14
      GROUP BY page_url
      ORDER BY ABS(COALESCE(SUM(clicks) FILTER (WHERE date >= NOW()::date - 7), 0)
                 - COALESCE(SUM(clicks) FILTER (WHERE date <  NOW()::date - 7), 0)) DESC
      LIMIT 3`,
    [tenantId],
  )
  const topMovers: DigestMover[] = moverRows.map(r => ({
    pageUrl: r.page_url, clicksLast7: Number(r.last7), clicksPrior7: Number(r.prior7),
  }))

  // ── Assemble + upsert ─────────────────────────────────────────────────
  const payload: DigestPayload = {
    tenantId, digestDate, actions, articles, discards,
    pendingHuman: pendingRows.map(r => ({ toolName: r.tool_name, proposedAction: r.proposed_action })),
    outcomes,
    metrics: { last7, prior7, topMovers },
  }
  const summaryMd = buildDigestMarkdown(payload, tenant.clientName)

  await db.query(
    `INSERT INTO daily_digests (tenant_id, digest_date, payload, summary_md)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (tenant_id, digest_date)
     DO UPDATE SET payload = EXCLUDED.payload,
                   summary_md = EXCLUDED.summary_md,
                   updated_at = NOW()`,
    [tenantId, digestDate, JSON.stringify(payload), summaryMd],
  )

  result.actions  = actions.length
  result.articles = articles.length
  result.written  = true
  logger.info('daily_digest_written', { tenantId, digestDate, actions: actions.length, articles: articles.length })
  return result
}
