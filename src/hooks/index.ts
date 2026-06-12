// src/hooks/index.ts
//
// preToolUseHook — the HITL gate for high-risk tool calls.
//
// R3.1 architecture:
//   - Request time: write to BOTH Postgres (operational state) AND Google
//     Sheet (persistent audit record). Same approval ID across both.
//     PG write is required; Sheet write is best-effort (failures logged
//     but don't block the agent).
//   - Wait path: poll Postgres (state-store.waitForApprovalResolution).
//     ~1.5s poll interval → click-to-unblock under 2 seconds.
//   - Resolution: Slack button handlers (hitl/handlers.ts) update PG
//     immediately, then mirror the decision to the Sheet so the
//     persistent record stays accurate.
//
// The Sheet retains a one-line-per-approval audit trail you can scan
// historically, filter, share, and reference in client reviews. Direct
// Sheet edits don't currently flow back to PG — that's a follow-up.

import { Pool } from 'pg'
import { ToolUseEvent, HookDecision } from '../types'
import { TenantConfig } from '../tenants/types'
import { config } from '../config'
import { classifyRisk } from './riskClassifier'
import {
  createApproval,
  waitForApprovalResolution,
} from '../hitl/state-store'
import { trace } from '../observability/langfuse'
import { presenter } from '../core/slack'
import { logger } from '../logger'

export interface HookContext {
  taskId:    string
  sessionId: string
  agentType: string
  tenant:    TenantConfig
  /** Slack channel for approval messages — usually the same channel the
   *  task was triggered in. Required so HITL approval requests post to
   *  the right place rather than a default. */
  channelId: string
}

const APPROVAL_TIMEOUT = 30 * 60 * 1000 // 30 min

// Lazy-init connection pool — one per process, shared with state-store via
// connection string. Avoids module-load-time DB connection.
let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL })
  return _pool
}

function summariseToolInput(tool: string, input: any): string {
  try {
    if (!input || typeof input !== 'object') return ''
    if (tool === 'web_fetch' || tool === 'web_search') return String(input.url ?? input.query ?? '').slice(0, 200)
    if (tool === 'read_file' || tool === 'write_file' || tool === 'list_directory') return String(input.path ?? '').slice(0, 200)
    if (tool === 'run_command') return String(input.command ?? '').slice(0, 200)
    if (tool === 'propose_action') return String(input.action_type ?? input.opportunity_type ?? '').slice(0, 80)
    for (const v of Object.values(input)) {
      if (typeof v === 'string') return v.slice(0, 200)
    }
    return ''
  } catch { return '' }
}

export async function preToolUseHook(
  event: ToolUseEvent,
  ctx: HookContext
): Promise<HookDecision> {
  const risk = classifyRisk(event, ctx.agentType)

  logger.info('tool_call', {
    tenantId:    ctx.tenant.tenantId,
    taskId:      ctx.taskId,
    tool:        event.toolName,
    risk:        risk.level,
    autoApprove: risk.autoApprove,
    // Short target string for diagnostics — URL for web_fetch, path for
    // file ops, first chars of cmd for run_command. Without this a
    // tool-call hang is invisible in logs.
    target:      summariseToolInput(event.toolName, event.toolInput),
  })

  await trace({
    name:      'tool_use',
    sessionId: ctx.sessionId,
    taskId:    ctx.taskId,
    metadata:  { tool: event.toolName, risk: risk.level, reason: risk.reason },
  })

  if (risk.autoApprove) return { approved: true }

  // ── High / critical: dual-write approval to PG + Sheet, then wait on PG ──
  logger.warn('approval_required', {
    tenantId: ctx.tenant.tenantId, tool: event.toolName, risk: risk.level,
  })

  // 1. Write to Postgres (operational state — REQUIRED).
  //    The DB-generated UUID is the canonical approval ID.
  //    'critical' risk maps to 'high' for the ApprovalRiskLevel column;
  //    risk_level in PG is a TEXT column so the original level is preserved
  //    in risk_reason for full audit context.
  const dbRiskLevel: 'low' | 'medium' | 'high' =
    risk.level === 'critical' ? 'high' :
    risk.level === 'low'      ? 'low'  :
    risk.level === 'medium'   ? 'medium' :
                                'high'

  let approvalRow
  try {
    approvalRow = await createApproval(pool(), {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      sessionId:  ctx.sessionId,
      toolName:   event.toolName,
      toolInput:  event.toolInput,
      riskLevel:  dbRiskLevel,
      riskReason: risk.level === 'critical'
        ? `[${risk.level.toUpperCase()}] ${risk.reason}`
        : risk.reason,
      slackChannelId: ctx.channelId,
    })
  } catch (err) {
    // PG write failure is fatal for the approval flow. Without a DB row,
    // there's nothing for Slack buttons to update, and the agent can't
    // poll for resolution. Fail the tool call rather than letting it
    // through silently.
    logger.error('approval_pg_write_failed', {
      tenantId: ctx.tenant.tenantId, tool: event.toolName, err: String(err),
    })
    return {
      approved: false,
      reason: `Could not persist approval request: ${String(err).slice(0, 200)}`,
    }
  }

  const approvalId = approvalRow.id

  // 2. Post the approval card to Slack.
  await presenter.requestApproval({
    tenantId:   ctx.tenant.tenantId,
    channelId:  ctx.channelId,
    taskId:     ctx.taskId,
    toolName:   event.toolName,
    riskLevel:  risk.level,
    riskReason: risk.reason,
    approvalId,
  })

  // 4. Wait for resolution by polling PG. Slack button click → PG
  //    update → poll picks it up within ~1.5s.
  try {
    const decision = await waitForApprovalResolution(pool(), approvalId, APPROVAL_TIMEOUT)
    if (decision.status === 'approved') {
      logger.info('approval_granted', { approvalId, tool: event.toolName, by: decision.resolvedBy })
      await presenter.approvalResolved({
        tenantId:   ctx.tenant.tenantId,
        channelId:  ctx.channelId,
        taskId:     ctx.taskId,
        toolName:   event.toolName,
        approvalId,
        decision:   'approved',
        resolvedBy: decision.resolvedBy,
      })
      return { approved: true }
    }
    logger.info('approval_rejected', { approvalId, reason: decision.rejectionReason, by: decision.resolvedBy })
    await presenter.approvalResolved({
      tenantId:        ctx.tenant.tenantId,
      channelId:       ctx.channelId,
      taskId:          ctx.taskId,
      toolName:        event.toolName,
      approvalId,
      decision:        'rejected',
      resolvedBy:      decision.resolvedBy,
      rejectionReason: decision.rejectionReason,
    })
    return { approved: false, reason: `Rejected by ${decision.resolvedBy}: ${decision.rejectionReason ?? ''}` }
  } catch {
    logger.error('approval_timeout', { approvalId })
    await presenter.approvalResolved({
      tenantId:   ctx.tenant.tenantId,
      channelId:  ctx.channelId,
      taskId:     ctx.taskId,
      toolName:   event.toolName,
      approvalId,
      decision:   'timeout',
    })
    return { approved: false, reason: 'Approval timed out after 30 minutes' }
  }
}
