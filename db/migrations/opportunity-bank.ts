// db/migrations/opportunity-bank.ts
//
// Adds the columns + indexes needed for the opportunity bank:
//
//   seo_opportunities:
//     surfaced_in_run_id   — daily run ID that surfaced this opportunity
//     surfaced_at          — timestamp of the transition to 'surfaced'
//     dismissed_reason     — reason captured at dismissal (if rejected with one)
//     reshape_source_id    — if this row was reshaped from another, points to original
//     reshape_target_id    — if this row was rejected with substantive feedback,
//                            points to the reshape descendant
//     reshape_count        — lineage depth; capped to prevent infinite reshape cycles
//     CHECK status widened to include 'surfaced'
//
//   approval_requests:
//     opportunity_id       — back-link to the opportunity that produced this approval
//                            (nullable; not all approvals come from opportunities)
//
// Idempotent — safe to re-run.

import type { Pool } from 'pg'

export async function runOpportunityBankMigration(pool: Pool): Promise<void> {
  // ── seo_opportunities columns ─────────────────────────────────────────
  await pool.query(`
    ALTER TABLE seo_opportunities
      ADD COLUMN IF NOT EXISTS surfaced_in_run_id  UUID,
      ADD COLUMN IF NOT EXISTS surfaced_at         TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS dismissed_reason    TEXT,
      ADD COLUMN IF NOT EXISTS reshape_source_id   UUID,
      ADD COLUMN IF NOT EXISTS reshape_target_id   UUID,
      ADD COLUMN IF NOT EXISTS reshape_count       INTEGER NOT NULL DEFAULT 0
  `)

  // Widen status CHECK to include 'surfaced'. Drop the old one if present.
  // Existing values ('new', 'queued', 'in_progress', 'executed', 'rejected',
  // 'stale') all remain valid.
  await pool.query(`
    ALTER TABLE seo_opportunities
      DROP CONSTRAINT IF EXISTS seo_opportunities_status_check
  `)
  await pool.query(`
    ALTER TABLE seo_opportunities
      ADD CONSTRAINT seo_opportunities_status_check CHECK (status IN
        ('new', 'surfaced', 'queued', 'in_progress', 'executed', 'rejected', 'stale'))
  `)

  // Bank-query index: (tenant, status, priority, freshness) covers the
  // selection algorithm's hot path.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_opportunities_bank_query
      ON seo_opportunities (tenant_id, status, priority, created_at DESC)
  `)

  // Reshape lineage trace index.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_opportunities_reshape_source
      ON seo_opportunities (reshape_source_id)
      WHERE reshape_source_id IS NOT NULL
  `)

  // ── approval_requests → opportunity link ──────────────────────────────
  await pool.query(`
    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS opportunity_id UUID
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_approval_opportunity
      ON approval_requests (opportunity_id)
      WHERE opportunity_id IS NOT NULL
  `)
}
