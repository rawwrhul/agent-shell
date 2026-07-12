// db/migrations/daily-digests.ts
//
// daily_digests — one row per tenant per day, written by the silent
// 'daily_digest' cycle. NOT sent anywhere: it's a persisted record
// (structured JSONB + rendered markdown) for dashboards, client reporting,
// or later retrieval. Upsert on (tenant_id, digest_date) so re-runs are
// idempotent.
//
// Also widens the tenant_schedules run_kind CHECK to allow 'daily_digest'
// (superset re-add — see the hard-learned rule in metrics-history.ts).

import type { Pool } from 'pg'

export async function runDailyDigestsMigration(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_digests (
      tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
      digest_date  DATE NOT NULL,
      payload      JSONB NOT NULL,
      summary_md   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, digest_date)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_digests_tenant_date
      ON daily_digests (tenant_id, digest_date DESC)`)

  await pool.query(`ALTER TABLE tenant_schedules DROP CONSTRAINT IF EXISTS tenant_schedules_run_kind_check`)
  await pool.query(`
    ALTER TABLE tenant_schedules ADD CONSTRAINT tenant_schedules_run_kind_check
      CHECK (run_kind IN ('daily','daily_pm','weekly','end-of-week','seo_audit',
                          'backlink_prospect','brand_mention_scan','metrics_sync','strategy_refresh',
                          'metadata_edit','copy_optimise','internal_link','article_create',
                          'outcome_score','daily_digest'))`)

  console.log('  daily-digests: table ready; daily_digest allowed in run_kind')
}
