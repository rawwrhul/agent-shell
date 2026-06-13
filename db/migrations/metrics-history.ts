// db/migrations/metrics-history.ts
//
// Phase 1 — GSC + GA4 import & storage.
//
// ranking_history: GSC search analytics at (date, query, page) grain.
// traffic_history: GA4 at (date, page, source/medium) grain.
//
// Both have a UNIQUE index matching the sync upsert's ON CONFLICT target —
// re-running any window overwrites in place, never duplicates. GSC data
// mutates for ~3 days after the fact, so the sync always re-pulls a
// trailing window; idempotent upserts make that free.
//
// Also codifies the tenant_schedules run_kind CHECK to match the worker's
// actual dispatch (incl. metrics_sync and the SEO-5 kinds that previously
// only existed in hand-run SQL — drift that has bitten twice).

import { Pool } from 'pg'

export async function runMetricsHistoryMigration(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_history (
      id           BIGSERIAL PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      date         DATE NOT NULL,
      keyword      TEXT NOT NULL,
      page_url     TEXT NOT NULL,
      position     REAL NOT NULL,
      ctr          REAL NOT NULL,
      impressions  INTEGER NOT NULL,
      clicks       INTEGER NOT NULL,
      source       TEXT NOT NULL DEFAULT 'gsc',
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ranking_history_upsert
      ON ranking_history (tenant_id, date, keyword, page_url)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ranking_history_tenant_date
      ON ranking_history (tenant_id, date DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS traffic_history (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      date           DATE NOT NULL,
      page_url       TEXT NOT NULL,
      source_medium  TEXT NOT NULL DEFAULT '(all)',
      sessions       INTEGER NOT NULL DEFAULT 0,
      conversions    INTEGER NOT NULL DEFAULT 0,
      bounce_rate    REAL,
      synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_traffic_history_upsert
      ON traffic_history (tenant_id, date, page_url, source_medium)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_traffic_history_tenant_date
      ON traffic_history (tenant_id, date DESC)`)

  // Codify the run_kind constraint (idempotent drop/recreate).
  await pool.query(`ALTER TABLE tenant_schedules DROP CONSTRAINT IF EXISTS tenant_schedules_run_kind_check`)
  await pool.query(`
    ALTER TABLE tenant_schedules ADD CONSTRAINT tenant_schedules_run_kind_check
      CHECK (run_kind IN ('daily','weekly','end-of-week','seo_audit',
                          'backlink_prospect','brand_mention_scan','metrics_sync','strategy_refresh',
                          'metadata_edit','copy_optimise','internal_link','article_create'))`)

  console.log('  metrics-history: ranking_history + traffic_history ready; run_kind constraint codified')
}
