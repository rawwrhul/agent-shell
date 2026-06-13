// src/core/metrics/tools.ts
//
// Historical-performance tools reading the Phase 1 history tables
// (ranking_history from GSC, traffic_history from GA4). Zero vendor cost,
// fast SQL, tenant-scoped. Available whenever the tenant has gsc or ga4
// enabled — the tables only fill for those tenants.
//
// Activity mapping:
//   Content rewriting    → metrics_page_history (is this page declining?
//                          what did the last change do?), metrics_top_movers
//                          (losers = rewrite candidates)
//   Copy + Metadata opt. → metrics_keyword_history (did the title change
//                          move position/CTR for the target query?)
//   Reporting / pulse    → metrics_performance_summary (period vs prior)
//
// Window convention: "current" windows end 2 days ago because the freshest
// GSC days are partial and mutate for ~3 days. Comparisons are honest only
// on settled data.

import Anthropic from '@anthropic-ai/sdk'
import { Pool } from 'pg'
import { pool } from '../../memory/postgres'

export const METRICS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'metrics_performance_summary',
    description: 'Aggregate organic performance for the last N settled days vs the prior N days, from stored GSC + GA4 history: clicks, impressions, weighted avg position, sessions, conversions — with deltas. Use to ground any claim about how the site is trending. Free and instant (local data).',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Window size in days (default 7, max 90)' } },
    },
  },
  {
    name: 'metrics_page_history',
    description: 'Weekly performance time series for ONE page from stored history: clicks, impressions, avg position, sessions. Use BEFORE proposing a rewrite (is it actually declining?) and AFTER changes ship (did it move?). Free and instant.',
    input_schema: {
      type: 'object',
      properties: {
        page_url: { type: 'string', description: 'Full page URL as it appears in GSC' },
        days:     { type: 'number', description: 'Lookback in days (default 90, max 480)' },
      },
      required: ['page_url'],
    },
  },
  {
    name: 'metrics_keyword_history',
    description: 'Weekly position/clicks/impressions trend for ONE keyword from stored GSC history. Use to verify whether a metadata or copy change moved the target query. Free and instant.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        days:    { type: 'number', description: 'Lookback in days (default 90, max 480)' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'metrics_top_movers',
    description: 'Pages with the largest click change, last N settled days vs prior N — winners AND losers. Losers are decay/rewrite candidates; winners validate what worked. Use at the start of content-planning to pick targets from real data. Free and instant.',
    input_schema: {
      type: 'object',
      properties: {
        days:  { type: 'number', description: 'Window size in days (default 7, max 90)' },
        limit: { type: 'number', description: 'Movers per direction (default 5, max 15)' },
      },
    },
  },
]

export function isMetricsToolName(name: string): boolean {
  return name.startsWith('metrics_')
}

function clampDays(v: unknown, dflt: number, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : dflt
}

export async function executeMetricsTool(
  name:     string,
  input:    Record<string, unknown>,
  tenantId: string,
  db: Pool = pool,
): Promise<string> {
  try {
    switch (name) {
      case 'metrics_performance_summary': {
        const days = clampDays(input.days, 7, 90)
        const res = await db.query(
          `WITH cur AS (
             SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions,
                    CASE WHEN SUM(impressions) > 0
                         THEN ROUND((SUM(position*impressions)/SUM(impressions))::numeric, 1) END avg_position
             FROM ranking_history
             WHERE tenant_id=$1 AND date >= CURRENT_DATE - ($2::int + 2) AND date < CURRENT_DATE - 2
           ), prev AS (
             SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions,
                    CASE WHEN SUM(impressions) > 0
                         THEN ROUND((SUM(position*impressions)/SUM(impressions))::numeric, 1) END avg_position
             FROM ranking_history
             WHERE tenant_id=$1 AND date >= CURRENT_DATE - (2*$2::int + 2) AND date < CURRENT_DATE - ($2::int + 2)
           ), tcur AS (
             SELECT COALESCE(SUM(sessions),0) sessions, COALESCE(SUM(conversions),0) conversions
             FROM traffic_history
             WHERE tenant_id=$1 AND date >= CURRENT_DATE - ($2::int + 2) AND date < CURRENT_DATE - 2
           ), tprev AS (
             SELECT COALESCE(SUM(sessions),0) sessions, COALESCE(SUM(conversions),0) conversions
             FROM traffic_history
             WHERE tenant_id=$1 AND date >= CURRENT_DATE - (2*$2::int + 2) AND date < CURRENT_DATE - ($2::int + 2)
           )
           SELECT cur.clicks, cur.impressions, cur.avg_position,
                  prev.clicks prev_clicks, prev.impressions prev_impressions, prev.avg_position prev_avg_position,
                  tcur.sessions, tcur.conversions, tprev.sessions prev_sessions, tprev.conversions prev_conversions
           FROM cur, prev, tcur, tprev`,
          [tenantId, days],
        )
        const r = res.rows[0]
        if (!r || (Number(r.clicks) === 0 && Number(r.prev_clicks) === 0 && Number(r.sessions) === 0)) {
          return JSON.stringify({ note: 'No stored history yet for this window. Run npm run metrics:backfill or wait for the daily metrics_sync.' })
        }
        return JSON.stringify({ window_days: days, note: 'windows end 2 days ago (GSC settles ~3 days)', ...r }, null, 2)
      }

      case 'metrics_page_history': {
        const pageUrl = String(input.page_url || '')
        if (!pageUrl) return 'metrics_page_history error: page_url is required'
        const days = clampDays(input.days, 90, 480)
        const res = await db.query(
          `SELECT date_trunc('week', r.date)::date week,
                  SUM(r.clicks) clicks, SUM(r.impressions) impressions,
                  CASE WHEN SUM(r.impressions) > 0
                       THEN ROUND((SUM(r.position*r.impressions)/SUM(r.impressions))::numeric,1) END avg_position,
                  MAX(t.sessions) sessions
           FROM ranking_history r
           LEFT JOIN (
             SELECT date_trunc('week', date)::date week, SUM(sessions) sessions
             FROM traffic_history WHERE tenant_id=$1 AND page_url=$2 GROUP BY 1
           ) t ON t.week = date_trunc('week', r.date)::date
           WHERE r.tenant_id=$1 AND r.page_url=$2 AND r.date >= CURRENT_DATE - $3::int
           GROUP BY 1 ORDER BY 1`,
          [tenantId, pageUrl, days],
        )
        if (res.rows.length === 0) return JSON.stringify({ note: `No stored history for ${pageUrl}. Check the URL matches GSC exactly (protocol, trailing slash).` })
        return JSON.stringify({ page_url: pageUrl, weeks: res.rows }, null, 2)
      }

      case 'metrics_keyword_history': {
        const keyword = String(input.keyword || '').trim()
        if (!keyword) return 'metrics_keyword_history error: keyword is required'
        const days = clampDays(input.days, 90, 480)
        const res = await db.query(
          `SELECT date_trunc('week', date)::date week,
                  SUM(clicks) clicks, SUM(impressions) impressions,
                  CASE WHEN SUM(impressions) > 0
                       THEN ROUND((SUM(position*impressions)/SUM(impressions))::numeric,1) END avg_position
           FROM ranking_history
           WHERE tenant_id=$1 AND keyword=$2 AND date >= CURRENT_DATE - $3::int
           GROUP BY 1 ORDER BY 1`,
          [tenantId, keyword, days],
        )
        if (res.rows.length === 0) return JSON.stringify({ note: `No stored history for keyword "${keyword}".` })
        return JSON.stringify({ keyword, weeks: res.rows }, null, 2)
      }

      case 'metrics_top_movers': {
        const days  = clampDays(input.days, 7, 90)
        const limit = clampDays(input.limit, 5, 15)
        const res = await db.query(
          `WITH cur AS (
             SELECT page_url, SUM(clicks) clicks FROM ranking_history
             WHERE tenant_id=$1 AND date >= CURRENT_DATE - ($2::int + 2) AND date < CURRENT_DATE - 2
             GROUP BY 1
           ), prev AS (
             SELECT page_url, SUM(clicks) clicks FROM ranking_history
             WHERE tenant_id=$1 AND date >= CURRENT_DATE - (2*$2::int + 2) AND date < CURRENT_DATE - ($2::int + 2)
             GROUP BY 1
           ), deltas AS (
             SELECT COALESCE(cur.page_url, prev.page_url) page_url,
                    COALESCE(cur.clicks,0) clicks_now, COALESCE(prev.clicks,0) clicks_before,
                    COALESCE(cur.clicks,0) - COALESCE(prev.clicks,0) delta
             FROM cur FULL OUTER JOIN prev USING (page_url)
           )
           (SELECT 'winner' kind, * FROM deltas WHERE delta > 0 ORDER BY delta DESC LIMIT $3)
           UNION ALL
           (SELECT 'loser' kind, * FROM deltas WHERE delta < 0 ORDER BY delta ASC LIMIT $3)`,
          [tenantId, days, limit],
        )
        if (res.rows.length === 0) return JSON.stringify({ note: 'No stored history yet for this window.' })
        return JSON.stringify({
          window_days: days,
          winners: res.rows.filter(r => r.kind === 'winner'),
          losers:  res.rows.filter(r => r.kind === 'loser'),
        }, null, 2)
      }

      default:
        return `Unknown metrics tool: ${name}`
    }
  } catch (err) {
    return `${name} error: ${String(err).slice(0, 300)}`
  }
}
