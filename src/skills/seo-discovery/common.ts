// src/skills/seo-discovery/common.ts
//
// Phase 2, unit 3: shared gather for the ranking-driven discovery cycles.
//
// One loader, one settled window, one per-query impression floor — so every
// cycle (metadata_edit, copy_optimise, internal_link) sees the same grounded
// ranking surface and none of them count single-impression noise toward EV or
// gap counts. Tighten the floor here and all cycles inherit it.

import { pool } from '../../memory/postgres'

/** A query must clear this many impressions in the window to be considered. */
export const MIN_QUERY_IMPRESSIONS = 5

/** Settled window: [today - START, today - SETTLE_OFFSET). GSC lags ~3 days. */
export const RANK_WINDOW_START = 30
export const RANK_SETTLE_OFFSET = 2

export interface RankingRow {
  pageUrl:     string
  keyword:     string
  clicks:      number
  impressions: number
  pos:         number
}

/**
 * Per-(page, query) ranking aggregates over the settled window, with the
 * per-query impression floor applied in SQL. Weighted average position.
 */
export async function loadRankingRows(tenantId: string): Promise<RankingRow[]> {
  const res = await pool.query(
    `SELECT page_url, keyword,
            SUM(clicks)::int clicks, SUM(impressions)::int impressions,
            SUM(position*impressions)/NULLIF(SUM(impressions),0) pos
     FROM ranking_history
     WHERE tenant_id=$1 AND date >= CURRENT_DATE - $2::int AND date < CURRENT_DATE - $3::int
     GROUP BY page_url, keyword
     HAVING SUM(impressions) >= $4`,
    [tenantId, RANK_WINDOW_START, RANK_SETTLE_OFFSET, MIN_QUERY_IMPRESSIONS],
  )
  return res.rows.map((r) => ({
    pageUrl: r.page_url, keyword: r.keyword,
    clicks: Number(r.clicks), impressions: Number(r.impressions), pos: Number(r.pos),
  }))
}

/** Group ranking rows by page URL. */
export function groupByPage(rows: RankingRow[]): Map<string, RankingRow[]> {
  const m = new Map<string, RankingRow[]>()
  for (const r of rows) {
    const list = m.get(r.pageUrl) ?? []
    list.push(r)
    m.set(r.pageUrl, list)
  }
  return m
}

export function round2(n: number): number { return Math.round(n * 100) / 100 }
export function round4(n: number): number { return Math.round(n * 10000) / 10000 }
