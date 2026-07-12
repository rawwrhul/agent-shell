// src/hitl/autonomy.ts
//
// Tenant-level autonomy: auto-approve seam for 'full' autonomy tenants.
//
// Mirrors exactly what handleApprove (handlers.ts) does on a human click —
// resolveApproval → onApprovalResolved (L2 memory) → onApprovalApproved
// (execution enqueue) — minus the Slack message editing, because in
// autonomous mode no approval card was posted in the first place. Keeping
// the same three calls in the same order means the entire downstream
// pipeline (executor, pipeline-events, opportunity bank reads of
// approval_requests) sees an autonomous approval as indistinguishable from
// a human one except for resolved_by = '_autonomous_'.
//
// SAFETY BOUNDARIES (do not widen without deliberate review):
//   - Only tools with a registered executor are eligible. A tool without an
//     executor would resolve to "operator handles manually" — meaningless
//     without an operator in the loop, so those stay as HITL cards.
//   - Denylist for tools whose "execution" is really a human act:
//     manual_operator_task (operator does it in the Framer UI) and
//     outreach_send_mailto (operator sends an email from their own inbox).
//   - Stage-2 blog publishes are auto-approved by the CALLER
//     (execApproveBlogPitch) only after the Surfer quality gate passes;
//     this module does not know about content quality by design.

import type { Pool } from 'pg'
import { logger } from '../logger'
import { resolveApproval } from './state-store'
import { onApprovalApproved } from './execution-hook'
import { onApprovalResolved } from '../memory/pipeline-events'
import { isExecutableToolName } from '../execution/dispatcher'
import type { TenantConfig } from '../tenants/types'

export const AUTONOMOUS_RESOLVER = '_autonomous_'

/** Tools that must never auto-approve even at autonomy_level='full'. */
const AUTO_EXECUTE_DENYLIST = new Set<string>([
  'manual_operator_task',
  'outreach_send_mailto',
])

export function isFullyAutonomous(tenant: Pick<TenantConfig, 'autonomyLevel'> | null | undefined): boolean {
  return tenant?.autonomyLevel === 'full'
}

/** Can this tool_name be auto-approved and actually executed end-to-end? */
export function isAutoExecutable(toolName: string): boolean {
  return isExecutableToolName(toolName) && !AUTO_EXECUTE_DENYLIST.has(toolName)
}

export interface AutoApproveArgs {
  approvalId:     string
  tenantId:       string
  toolName:       string
  toolInput:      Record<string, unknown>
  proposedAction?: string | null
}

export interface AutoApproveResult {
  approved: boolean
  enqueued: boolean
  reason?:  string
}

/**
 * Resolve a pending approval as approved-by-the-system and enqueue its
 * executor. Caller is responsible for the autonomy checks (isFullyAutonomous
 * + isAutoExecutable, plus any quality gates) BEFORE calling this — the
 * function itself only performs the state transition.
 *
 * Never throws: an auto-approve failure must not kill the proposing run.
 * On failure the row is left pending, i.e. it degrades to the normal HITL
 * path and will surface in the anchor report / pending-nudge scan.
 */
export async function autoApproveAndExecute(
  pool: Pool, args: AutoApproveArgs,
): Promise<AutoApproveResult> {
  try {
    const resolved = await resolveApproval(pool, {
      approvalId: args.approvalId,
      decision:   'approved',
      resolvedBy: AUTONOMOUS_RESOLVER,
    })
    if (!resolved) {
      // Row wasn't pending (already resolved elsewhere) — nothing to do.
      return { approved: false, enqueued: false, reason: 'not_pending' }
    }

    // L2 memory: same terminal-outcome capture a human click produces.
    void onApprovalResolved({
      approvalId:     args.approvalId,
      tenantId:       args.tenantId,
      toolName:       args.toolName,
      proposedAction: args.proposedAction ?? null,
      toolInput:      args.toolInput,
      status:         'approved',
      resolvedBy:     AUTONOMOUS_RESOLVER,
    })

    const r = await onApprovalApproved(args.approvalId)
    logger.info('autonomous_auto_approved', {
      approvalId: args.approvalId,
      tenantId:   args.tenantId,
      toolName:   args.toolName,
      enqueued:   r.enqueued,
      reason:     r.reason,
    })
    return { approved: true, enqueued: r.enqueued, reason: r.reason }
  } catch (err) {
    logger.error('autonomous_auto_approve_failed', {
      approvalId: args.approvalId,
      tenantId:   args.tenantId,
      toolName:   args.toolName,
      err:        String(err).slice(0, 300),
      hint:       'Row left pending — degrades to the HITL path, will surface in the anchor report.',
    })
    return { approved: false, enqueued: false, reason: `error: ${String(err).slice(0, 120)}` }
  }
}
