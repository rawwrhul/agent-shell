// src/feedback/state.ts
//
// DB helpers for the thread-feedback refinement flow.
// Lifted out of handler.ts so the SQL is in one place.

import type { Pool } from 'pg'
import type { ApprovalRow } from '../hitl/state-store'

/**
 * Find the most recent pending approval for a given task. The thread feedback
 * handler uses this to identify which pitch the operator is commenting on.
 * Returns null if no pending approval exists (the task may have already been
 * approved/rejected, or there's no pitch in flight).
 */
export async function findPendingPitchForTask(
  pool:   Pool,
  taskId: string,
): Promise<ApprovalRow | null> {
  const res = await pool.query(
    `SELECT id, tenant_id AS "tenantId", task_id AS "taskId",
            tool_name AS "toolName", tool_input AS "toolInput",
            status, parent_approval_id AS "parentApprovalId",
            preview_url AS "previewUrl"
       FROM approval_requests
      WHERE task_id = $1
        AND status  = 'pending'
        AND tool_name IN ('approve_blog_pitch', 'framer_confirm_publish')
      ORDER BY requested_at DESC
      LIMIT 1`,
    [taskId],
  )
  if (!res.rows.length) return null
  return res.rows[0] as unknown as ApprovalRow
}

/**
 * Look up the parent approval (Stage 1) for a given Stage 2 approval row.
 * Used to recover the original full pitch content when refining at Stage 2 —
 * Stage 2's own tool_input only has {itemId, confirmationHash, slug, title},
 * not the content. But the Framer item itself is the live source of truth at
 * Stage 2; this is kept for reference/audit.
 */
export async function findParentApproval(
  pool:               Pool,
  parentApprovalId:   string,
): Promise<ApprovalRow | null> {
  const res = await pool.query(
    `SELECT id, tenant_id AS "tenantId", task_id AS "taskId",
            tool_name AS "toolName", tool_input AS "toolInput",
            status, parent_approval_id AS "parentApprovalId"
       FROM approval_requests
      WHERE id = $1`,
    [parentApprovalId],
  )
  if (!res.rows.length) return null
  return res.rows[0] as unknown as ApprovalRow
}

/**
 * Apply a refinement to an existing approval row's tool_input. Used for
 * Stage 1 refinements where the pitch lives entirely in the DB and Framer
 * hasn't been written yet.
 *
 * The mergedFields are spread onto the existing tool_input — pass only the
 * keys that changed.
 */
export async function updateApprovalToolInput(
  pool:         Pool,
  approvalId:   string,
  mergedFields: Record<string, unknown>,
): Promise<void> {
  // tool_input is JSONB; we merge by reading + writing to keep this driver-agnostic.
  const existing = await pool.query(
    'SELECT tool_input FROM approval_requests WHERE id = $1',
    [approvalId],
  )
  if (!existing.rows.length) throw new Error(`approval ${approvalId} not found`)
  const merged = { ...(existing.rows[0].tool_input ?? {}), ...mergedFields }
  await pool.query(
    'UPDATE approval_requests SET tool_input = $2, updated_at = NOW() WHERE id = $1',
    [approvalId, merged],
  )
}
