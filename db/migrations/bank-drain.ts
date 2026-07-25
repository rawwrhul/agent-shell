// db/migrations/bank-drain.ts
//
// Widens the tenant_schedules run_kind CHECK to allow 'bank_drain'
// (superset re-add — never narrow over existing rows). Adds a 'surfaced'
// -> handled note: the drain cycle marks consumed rows 'queued'/'rejected',
// both already valid seo_opportunities statuses; no table changes needed.

import type { Pool } from 'pg'

export async function runBankDrainMigration(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE tenant_schedules DROP CONSTRAINT IF EXISTS tenant_schedules_run_kind_check`)
  await pool.query(`
    ALTER TABLE tenant_schedules ADD CONSTRAINT tenant_schedules_run_kind_check
      CHECK (run_kind IN ('daily','daily_pm','weekly','end-of-week','seo_audit',
                          'backlink_prospect','brand_mention_scan','metrics_sync','strategy_refresh',
                          'metadata_edit','copy_optimise','internal_link','article_create',
                          'outcome_score','daily_digest','keyword_gap','bank_drain'))`)
  console.log('  bank-drain: bank_drain allowed in run_kind')
}
