// src/core/metrics/pulse.ts
//
// The performance pulse: one compact, deterministic line of real numbers
// stamped onto every completed daily-run report, so the client sees what's
// actually happening with their organic performance on every send —
// computed in SQL from stored history, never by the LLM (no hallucinated
// metrics on client-facing reports).
//
// Best-effort by design: no data (new tenant, pre-backfill, gsc disabled)
// → null → the report renders without a pulse line. Never blocks a send.
//
// Windows end 2 days ago because fresh GSC days are partial.

import { Pool } from 'pg'
import { logger } from '../../logger'

function pct(now: number, before: number): string {
  if (before === 0) return now > 0 ? '(new)' : ''
  const p = Math.round(((now - before) / before) * 100)
  return p === 0 ? '(±0%)' : p > 0 ? `(+${p}%)` : `(${p}%)`
}

function fmt(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export async function buildPerformancePulse(pool: Pool, tenantId: string): Promise<string | null> {
  try {
    const res = await pool.query(
      `WITH cur AS (
         SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i,
                CASE WHEN SUM(impressions) > 0
                     THEN ROUND((SUM(position*impressions)/SUM(impressions))::numeric,1) END p
         FROM ranking_history
         WHERE tenant_id=$1 AND date >= CURRENT_DATE - 9 AND date < CURRENT_DATE - 2
       ), prev AS (
         SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i,
                CASE WHEN SUM(impressions) > 0
                     THEN ROUND((SUM(position*impressions)/SUM(impressions))::numeric,1) END p
         FROM ranking_history
         WHERE tenant_id=$1 AND date >= CURRENT_DATE - 16 AND date < CURRENT_DATE - 9
       ), mover AS (
         SELECT cu.page_url, COALESCE(cu.c,0) - COALESCE(pv.c,0) d
         FROM (SELECT page_url, SUM(clicks) c FROM ranking_history
               WHERE tenant_id=$1 AND date >= CURRENT_DATE - 9 AND date < CURRENT_DATE - 2 GROUP BY 1) cu
         FULL OUTER JOIN (SELECT page_url, SUM(clicks) c FROM ranking_history
               WHERE tenant_id=$1 AND date >= CURRENT_DATE - 16 AND date < CURRENT_DATE - 9 GROUP BY 1) pv
         USING (page_url)
         ORDER BY ABS(COALESCE(cu.c,0) - COALESCE(pv.c,0)) DESC LIMIT 1
       )
       SELECT cur.c clicks, cur.i impressions, cur.p pos,
              prev.c pclicks, prev.i pimpr, prev.p ppos,
              mover.page_url mover_url, mover.d mover_delta
       FROM cur, prev LEFT JOIN mover ON true`,
      [tenantId],
    )
    const r = res.rows[0]
    if (!r) return null
    const clicks = Number(r.clicks), pclicks = Number(r.pclicks)
    const impr   = Number(r.impressions), pimpr = Number(r.pimpr)
    if (clicks === 0 && pclicks === 0) return null

    const parts = [
      `Last 7d: ${fmt(clicks)} clicks ${pct(clicks, pclicks)}`.trim(),
      `${fmt(impr)} impressions ${pct(impr, pimpr)}`.trim(),
    ]
    if (r.pos != null) {
      const pos = Number(r.pos)
      const delta = r.ppos != null ? Number(r.ppos) - pos : 0
      const arrow = delta > 0.05 ? ` (▲${delta.toFixed(1)})` : delta < -0.05 ? ` (▼${Math.abs(delta).toFixed(1)})` : ''
      parts.push(`avg pos ${pos}${arrow}`)
    }
    if (r.mover_url && Math.abs(Number(r.mover_delta)) >= 3) {
      const d = Number(r.mover_delta)
      const path = String(r.mover_url).replace(/^https?:\/\/[^/]+/, '') || '/'
      parts.push(`top mover: ${path} ${d > 0 ? '+' : ''}${d} clicks`)
    }
    return parts.join(' · ')
  } catch (err) {
    logger.warn('performance_pulse_failed', { tenantId, err: String(err).slice(0, 200) })
    return null
  }
}
