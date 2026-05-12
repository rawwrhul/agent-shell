// src/hitl/execution-hook.ts
//
// Bridge between HITL approval state changes and the execution worker.
//
// Call onApprovalApproved(approvalId) from anywhere status flips to 'approved':
//   - Slack button handler (handlers.ts: handleApprovalButton)
//   - Sheet-poller (if you add one)
//   - Any admin override path
//
// This is intentionally one function so there's one place to read for "what
// happens when an approval is approved." All the logic that follows from
// approval (PG update + Sheet mirror + execution dispatch) flows through here.

import { Pool } from 'pg'
import { config } from '../config'
import { logger } from '../logger'
import { enqueueApprovalExecutionJob } from '../queue/execution-producer'
import { isExecutableToolName } from '../execution/dispatcher'

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 })
  return _pool
}

interface ApprovalRow {
  id:         string
  tenant_id:  string
  task_id:    string
  tool_name:  string
  tool_input: Record<string, unknown>
  status:     string
  executed_at: string | null
}

/**
 * Called when an approval transitions to 'approved'. Idempotent — if the
 * approval is already executed, this is a no-op.
 *
 * Returns:
 *   - { enqueued: true }  if a job was enqueued
 *   - { enqueued: false, reason } otherwise (no handler, already executed, etc.)
 */
export async function onApprovalApproved(approvalId: string): Promise<{ enqueued: boolean; reason?: string }> {
  const { rows } = await pool().query<ApprovalRow>(
    `SELECT id, tenant_id, task_id, tool_name, tool_input, status, executed_at
       FROM approval_requests
      WHERE id = $1`,
    [approvalId],
  )
  if (rows.length === 0) {
    logger.warn('approval_not_found_for_execution', { approvalId })
    return { enqueued: false, reason: 'approval_not_found' }
  }

  const approval = rows[0]

  if (approval.status !== 'approved') {
    return { enqueued: false, reason: `status_not_approved: ${approval.status}` }
  }
  if (approval.executed_at) {
    return { enqueued: false, reason: 'already_executed' }
  }

  if (!isExecutableToolName(approval.tool_name)) {
    // The agent proposed something we don't have an executor for. That's not
    // a bug — many "approvals" today are still proposal-only because the
    // execution layer is in early rollout. Surface as a warning, not an error.
    logger.warn('approval_approved_but_no_executor', {
      approvalId,
      toolName: approval.tool_name,
      hint:     'agent proposed this action via propose_action but no execution handler is registered for tool_name. The operator approved it but it will not auto-ship. Add a handler in src/execution/dispatcher.ts if you want auto-execution.',
    })
    // Mark as manually-resolved-without-auto-exec so it doesn't reprocess
    await pool().query(
      `UPDATE approval_requests
         SET executed_at = now(), executed_outcome = 'approved (no auto-executor — operator handles manually)'
       WHERE id = $1`,
      [approvalId],
    )
    return { enqueued: false, reason: 'no_executor_registered' }
  }

  await enqueueApprovalExecutionJob({
    tenantId:   approval.tenant_id,
    taskId:     approval.task_id,
    approvalId: approval.id,
    toolName:   approval.tool_name,
    toolInput:  approval.tool_input ?? {},
  })

  return { enqueued: true }
}
