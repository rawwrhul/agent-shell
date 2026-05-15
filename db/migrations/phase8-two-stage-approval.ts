// db/migrations/phase8-two-stage-approval.ts
//
// Adds approval_requests.parent_approval_id for the two-stage approval flow.
// Idempotent — safe to re-run.

import type { Pool } from 'pg'

export async function runPhase8Migration(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS parent_approval_id UUID REFERENCES approval_requests(id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_approval_parent
      ON approval_requests (parent_approval_id)
      WHERE parent_approval_id IS NOT NULL
  `)
}
