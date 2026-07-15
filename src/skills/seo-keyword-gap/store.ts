// src/skills/seo-keyword-gap/store.ts
//
// DB access for the keyword_gap cycle. Table: seo.keyword_gap — one row per
// (tenant, keyword), refreshed each cycle. refreshed_at marks the last cycle
// that still saw the keyword as a gap; readers filter to the last 45 days so
// stale gaps (we started ranking, or the competitor dropped out) age away
// without a delete pass.

import { pool } from '../../memory/postgres'
import type { GapKeyword } from './gap'

export async function upsertGapRows(tenantId: string, gaps: ReadonlyArray<GapKeyword>): Promise<number> {
  let written = 0
  for (const g of gaps) {
    await pool.query(
      `INSERT INTO seo.keyword_gap (
         tenant_id, keyword, volume, difficulty, best_competitor_position,
         competitor_domains, competitor_url, first_seen, refreshed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (tenant_id, keyword) DO UPDATE SET
         volume                   = EXCLUDED.volume,
         difficulty               = EXCLUDED.difficulty,
         best_competitor_position = EXCLUDED.best_competitor_position,
         competitor_domains       = EXCLUDED.competitor_domains,
         competitor_url           = EXCLUDED.competitor_url,
         refreshed_at             = NOW()`,
      [tenantId, g.keyword, g.volume, g.difficulty, g.bestCompetitorPos, g.competitorDomains, g.competitorUrl],
    )
    written++
  }
  return written
}

/** Fresh gap rows (refreshed in the last 45 days), volume desc. */
export async function loadGapRows(tenantId: string, limit = 200): Promise<GapKeyword[]> {
  const res = await pool.query(
    `SELECT keyword, volume, difficulty, best_competitor_position, competitor_domains, competitor_url
     FROM seo.keyword_gap
     WHERE tenant_id = $1 AND refreshed_at > NOW() - interval '45 days'
     ORDER BY volume DESC
     LIMIT $2`,
    [tenantId, limit],
  )
  return res.rows.map((r) => ({
    keyword:           String(r.keyword),
    volume:            Number(r.volume),
    difficulty:        r.difficulty === null ? null : Number(r.difficulty),
    bestCompetitorPos: Number(r.best_competitor_position),
    competitorDomains: (r.competitor_domains ?? []) as string[],
    competitorUrl:     r.competitor_url === null ? null : String(r.competitor_url),
  }))
}

/** Normalized set of every keyword the tenant ranks for (any position, 90d). */
export async function loadOurKeywordSet(tenantId: string): Promise<Set<string>> {
  const res = await pool.query(
    `SELECT DISTINCT LOWER(TRIM(keyword)) AS kw
     FROM ranking_history
     WHERE tenant_id = $1 AND date >= CURRENT_DATE - 90`,
    [tenantId],
  )
  return new Set(res.rows.map((r) => String(r.kw)))
}
