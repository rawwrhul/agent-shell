// db/migrations/tenant-autonomy.ts
//
// Tenant autonomy tier. 'hitl' (default) keeps the existing human approval
// gate. 'full' auto-approves executable propose_action approvals and the
// Stage-2 publish gate — actions run immediately, Slack becomes a receipt
// stream. Per-tenant: HITL tenants are untouched.
//
// Also widens the tenant_schedules run_kind CHECK to allow 'daily_pm' — a
// second daily generation run for high-velocity autonomous tenants (two
// articles/day requires two bounded runs; one run cannot fit two full
// drafts inside token_budget_per_run).
//
// Idempotent. Constraint drop/re-add follows the metrics-history pattern:
// never narrows over existing rows, only widens.

import type { Pool } from 'pg'

export async function runTenantAutonomyMigration(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS autonomy_level TEXT NOT NULL DEFAULT 'hitl'
  `)
  await pool.query(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_autonomy_level_check`)
  await pool.query(`
    ALTER TABLE tenants ADD CONSTRAINT tenants_autonomy_level_check
      CHECK (autonomy_level IN ('hitl','full'))
  `)

  await pool.query(`ALTER TABLE tenant_schedules DROP CONSTRAINT IF EXISTS tenant_schedules_run_kind_check`)
  await pool.query(`
    ALTER TABLE tenant_schedules ADD CONSTRAINT tenant_schedules_run_kind_check
      CHECK (run_kind IN ('daily','daily_pm','weekly','end-of-week','seo_audit',
                          'backlink_prospect','brand_mention_scan','metrics_sync','strategy_refresh',
                          'metadata_edit','copy_optimise','internal_link','article_create'))`)

  console.log('  tenant-autonomy: autonomy_level column ready; daily_pm allowed in run_kind')
}
