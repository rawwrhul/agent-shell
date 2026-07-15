// db/migrations/keyword-gap.ts
//
// seo.keyword_gap — keywords competitors rank top-20 for that we don't rank
// for at all. Written by the 'keyword_gap' cycle (Ahrefs organic keywords per
// configured competitor, diffed against ranking_history). Read by strategy
// refresh (attack-cluster grounding) and copy/meta discovery (secondary
// targeting).
//
// Also widens the tenant_schedules run_kind CHECK to allow 'keyword_gap'
// (superset re-add — see the hard-learned rule in metrics-history.ts: never
// narrow a CHECK over existing rows).

import type { Pool } from 'pg'

export async function runKeywordGapMigration(pool: Pool): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS seo`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo.keyword_gap (
      tenant_id                 TEXT NOT NULL REFERENCES tenants(tenant_id),
      keyword                   TEXT NOT NULL,
      volume                    INTEGER NOT NULL DEFAULT 0,
      difficulty                INTEGER,
      best_competitor_position  NUMERIC(6,1) NOT NULL,
      competitor_domains        TEXT[] NOT NULL DEFAULT '{}',
      competitor_url            TEXT,
      first_seen                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      refreshed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, keyword)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_keyword_gap_tenant_refreshed
      ON seo.keyword_gap (tenant_id, refreshed_at DESC)`)

  await pool.query(`ALTER TABLE tenant_schedules DROP CONSTRAINT IF EXISTS tenant_schedules_run_kind_check`)
  await pool.query(`
    ALTER TABLE tenant_schedules ADD CONSTRAINT tenant_schedules_run_kind_check
      CHECK (run_kind IN ('daily','daily_pm','weekly','end-of-week','seo_audit',
                          'backlink_prospect','brand_mention_scan','metrics_sync','strategy_refresh',
                          'metadata_edit','copy_optimise','internal_link','article_create',
                          'outcome_score','daily_digest','keyword_gap'))`)

  console.log('  keyword-gap: seo.keyword_gap ready; keyword_gap allowed in run_kind')
}
