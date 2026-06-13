// db/migrations/opportunity-scoring.ts
//
// Phase 2, build unit 1: EV-scoring columns on seo_opportunities.
//
//   score                  — composite: expected_monthly_change / weeks_to_impact
//   ev_monthly_clicks       — estimated incremental monthly clicks
//   ev_monthly_conversions  — clicks × page_conversion_rate (null if scored in clicks)
//   weeks_to_impact         — realisation lag (also the calibration grading gate)
//   score_inputs            — JSONB breakdown for auditability
//
// Ordering index covers the bank's hot path: (tenant, status, score DESC).
// Idempotent — safe to re-run.

import type { Pool } from 'pg'

export async function runOpportunityScoringMigration(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE seo_opportunities
      ADD COLUMN IF NOT EXISTS score                  DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS ev_monthly_clicks      DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS ev_monthly_conversions DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS weeks_to_impact        DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS score_inputs           JSONB
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_opportunities_score
      ON seo_opportunities (tenant_id, status, score DESC NULLS LAST)
  `)
}
