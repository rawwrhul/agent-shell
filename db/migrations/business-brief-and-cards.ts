// db/migrations/business-brief-and-cards.ts
//
// Two foundational additions for closing the brand-grounding gap AND the
// missing-approval-cards gap:
//
//   - tenants.business_brief TEXT
//     Operator-authored 2-4 sentence description of what the tenant
//     actually does, who they serve, how they're positioned. Injected
//     into every LLM call (drafter, aggregator, subagent, synthesis) as
//     authoritative ground truth. Eliminates the "LLM guesses industry
//     from name" failure mode.
//
//   - tenants.operator_slack_user_id TEXT
//     Slack user ID (e.g. "U07A1B2C3DE") of the operator who should be
//     tagged on approval cards. Used by the bank-surface approval card
//     builder to produce <@USER_ID> mentions on cards that need human
//     attention.
//
// Idempotent — safe to re-run.

import type { Pool } from 'pg'

export async function runBusinessBriefAndCardsMigration(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS business_brief         TEXT,
      ADD COLUMN IF NOT EXISTS operator_slack_user_id TEXT
  `)
}
