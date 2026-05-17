// src/core/opportunity-bank/transitions.ts
//
// Atomic state transitions on seo_opportunities. All transitions guard
// the FROM state in their WHERE clause so concurrent updates don't
// double-fire effects (e.g. two reject handlers can't both spawn a
// reshape descendant).
//
// State machine (terminal states marked *):
//
//   new ──pickForDailyRun──→ surfaced ──approve──→ queued ──→ in_progress ──→ executed*
//                                    ├──reject (substantive)──→ rejected* + reshape descendant in 'new'
//                                    ├──reject (flat)─────────→ rejected*
//                                    └──age-out───────────────→ stale*
//
// reshapeSourceId / reshapeTargetId form the lineage chain so we can
// trace why a particular row exists.

import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import type { OppStatus } from './types'

/**
 * Mark a single opportunity as 'rejected'. Returns true if it actually
 * transitioned (i.e. was in an actionable state when called). Idempotent —
 * second call on an already-rejected row returns false without error.
 */
export async function markRejected(input: {
  opportunityId: string
  reason:        string | null
}): Promise<boolean> {
  const result = await pool.query(
    `UPDATE seo_opportunities
     SET status            = 'rejected',
         dismissed_reason  = $2,
         resolved_run_id   = NULL,
         updated_at        = NOW()
     WHERE id = $1
       AND status IN ('new', 'surfaced', 'queued', 'in_progress')`,
    [input.opportunityId, input.reason],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Link a reshape descendant to its source. Called immediately after
 * the descendant row has been INSERTed.
 */
export async function linkReshapeDescendant(input: {
  sourceId:     string
  descendantId: string
}): Promise<void> {
  await pool.query(
    `UPDATE seo_opportunities
     SET reshape_target_id = $2,
         updated_at        = NOW()
     WHERE id = $1`,
    [input.sourceId, input.descendantId],
  )
}

/**
 * Age out opportunities that have sat in 'surfaced' or 'queued' past a
 * window without being acted on. Caller is a periodic cron job (or the
 * daily run's pre-aggregation step). Returns the count aged.
 *
 * Default window: 14 days surfaced, 7 days queued. Queued is shorter
 * because the executor should have picked them up by then.
 */
export async function markStaleByAge(input: {
  surfacedDays?: number
  queuedDays?:   number
}): Promise<number> {
  const surfacedDays = input.surfacedDays ?? 14
  const queuedDays   = input.queuedDays ?? 7
  const result = await pool.query(
    `UPDATE seo_opportunities
     SET status     = 'stale',
         updated_at = NOW()
     WHERE
       (status = 'surfaced' AND surfaced_at < NOW() - ($1::int * INTERVAL '1 day'))
       OR
       (status = 'queued'   AND updated_at  < NOW() - ($2::int * INTERVAL '1 day'))`,
    [surfacedDays, queuedDays],
  )
  if ((result.rowCount ?? 0) > 0) {
    logger.info('opportunity_bank_aged_out', { count: result.rowCount })
  }
  return result.rowCount ?? 0
}

/**
 * Connect an approval_request row back to the opportunity it came from.
 * Called from propose_action's writer when the proposed action originates
 * from a banked opportunity. Idempotent.
 */
export async function linkApprovalToOpportunity(input: {
  approvalId:    string
  opportunityId: string
}): Promise<void> {
  await pool.query(
    `UPDATE approval_requests
     SET opportunity_id = $2
     WHERE id = $1
       AND opportunity_id IS NULL`,
    [input.approvalId, input.opportunityId],
  )
}

/**
 * Look up the opportunity (if any) linked to an approval request. Returns
 * null if there's no link or the opportunity doesn't exist.
 */
export async function getOpportunityForApproval(approvalId: string): Promise<{
  id:           string
  tenantId:     string
  type:         string
  target:       string | null
  description:  string
  rationale:    string | null
  priority:     string
  status:       OppStatus
  reshapeCount: number
} | null> {
  const result = await pool.query<{
    id: string; tenantId: string; type: string; target: string | null;
    description: string; rationale: string | null; priority: string;
    status: OppStatus; reshapeCount: number;
  }>(
    `SELECT
       o.id, o.tenant_id AS "tenantId", o.type, o.target,
       o.description, o.rationale, o.priority, o.status,
       o.reshape_count AS "reshapeCount"
     FROM seo_opportunities o
     JOIN approval_requests a ON a.opportunity_id = o.id
     WHERE a.id = $1`,
    [approvalId],
  )
  return result.rows[0] ?? null
}
