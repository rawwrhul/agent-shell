import { ToolUseEvent, HookDecision } from '../types'
import { TenantConfig } from '../tenants/types'
import { classifyRisk } from './riskClassifier'
import { createApprovalRequest, waitForApproval } from '../hitl/sheets'
import { trace } from '../observability/langfuse'
import { logger } from '../logger'

export interface HookContext {
  taskId:    string
  sessionId: string
  agentType: string
  tenant:    TenantConfig
  channelId?: string
}

const APPROVAL_TIMEOUT = 30 * 60 * 1000 // 30 min

export async function preToolUseHook(
  event: ToolUseEvent,
  ctx: HookContext
): Promise<HookDecision> {
  const risk = classifyRisk(event, ctx.agentType)

  logger.info('tool_call', {
    tenantId:  ctx.tenant.tenantId,
    taskId:    ctx.taskId,
    tool:      event.toolName,
    risk:      risk.level,
    autoApprove: risk.autoApprove,
  })

  await trace({
    name:      'tool_use',
    sessionId: ctx.sessionId,
    taskId:    ctx.taskId,
    metadata:  { tool: event.toolName, risk: risk.level, reason: risk.reason },
  })

  if (risk.autoApprove) return { approved: true }

  // High / critical — route to client's Google Sheet
  logger.warn('approval_required', { tenantId: ctx.tenant.tenantId, tool: event.toolName, risk: risk.level })

  const approvalId = await createApprovalRequest(ctx.tenant, {
    taskId:     ctx.taskId,
    sessionId:  ctx.sessionId,
    toolName:   event.toolName,
    toolInput:  event.toolInput,
    riskLevel:  risk.level,
    riskReason: risk.reason,
  })

  try {
    const decision = await waitForApproval(ctx.tenant, approvalId, APPROVAL_TIMEOUT)
    if (decision.status === 'approved') {
      logger.info('approval_granted', { approvalId, tool: event.toolName })
      return { approved: true }
    }
    logger.info('approval_rejected', { approvalId, reason: decision.rejectionReason })
    return { approved: false, reason: `Rejected by ${decision.resolvedBy}: ${decision.rejectionReason ?? ''}` }
  } catch {
    logger.error('approval_timeout', { approvalId })
    return { approved: false, reason: 'Approval timed out after 30 minutes' }
  }
}
