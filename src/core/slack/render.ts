// src/core/slack/render.ts
//
// As of Rollout 2: pure rendering of RunState → Block Kit RenderedMessage.
// NO I/O of any kind in this file — no DB, no Slack API, no logger.
//
// This module is the adapter between agent-shell's internal RunState shape
// and the Block Kit builders in ./blocks/. Every named export preserves its
// previous signature *from presenter.ts's perspective*; only the return type
// changed (string → RenderedMessage). presenter.ts passes both `text`
// (mobile push fallback) and `blocks` (rich layout) through to Slack's API.

import type {
  RunState, SpecialistEntry,
  ApprovalRequestInput, ApprovalResolvedInput, BudgetWarningInput,
} from './types'
import {
  renderAnchor as renderAnchorBlocks,
  renderSpecialistThread,
  renderFinalReportThread,
  renderApprovalRequest as renderApprovalRequestBlocks,
  renderApprovalResolved as renderApprovalResolvedBlocks,
  type AnchorState,
  type SpecialistState,
  type SpecialistThreadReply,
  type FinalReportThreadReply,
  type ApprovalRequest,
  type ApprovalResolution,
  type RenderedMessage,
} from './blocks'
import { header, section, context, fallbackText } from './blocks/shared'

// ────────────────────────────────────────────────────────────────────────────
// Anchor — edited in place over the lifetime of the run
// ────────────────────────────────────────────────────────────────────────────

export function renderAnchor(state: RunState): RenderedMessage {
  return renderAnchorBlocks(adaptRunStateToAnchor(state))
}

function adaptRunStateToAnchor(state: RunState): AnchorState {
  const specialists = Object.values(state.specialists).map(adaptSpecialist)
  return {
    tenantName: state.clientName,
    runId: state.taskId,
    phase: state.phase,
    startedAt: new Date(state.startedAt),
    updatedAt: new Date(),
    prompt: state.prompt,
    planSummary: state.planSummary,
    specialists,
    finalSummary:
      state.phase === 'complete' && state.finalReport
        ? state.finalReport.summaryText
        : undefined,
    errorMessage: state.errorSummary,
  }
}

function adaptSpecialist(s: SpecialistEntry): SpecialistState {
  switch (s.state.status) {
    case 'queued':
      return { id: s.type, name: s.name, status: 'pending' }
    case 'running':
      return {
        id: s.type,
        name: s.name,
        status: 'in_progress',
        startedAt: new Date(s.state.startedAt),
        summary: s.state.lastNote,
      }
    case 'complete':
      return {
        id: s.type,
        name: s.name,
        status: 'done',
        startedAt: new Date(s.state.startedAt),
        finishedAt: new Date(s.state.completedAt),
        summary: s.state.summary,
      }
    case 'failed':
      return {
        id: s.type,
        name: s.name,
        status: 'failed',
        startedAt: new Date(s.state.startedAt),
        finishedAt: new Date(s.state.failedAt),
        summary: s.state.error,
      }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Thread posts — per-specialist completion or failure
// ────────────────────────────────────────────────────────────────────────────

export function renderSpecialistComplete(s: SpecialistEntry): RenderedMessage {
  if (s.state.status !== 'complete') {
    return { text: '', blocks: [] }
  }
  const reply: SpecialistThreadReply = {
    specialistName: s.name,
    status: 'done',
    summary: s.state.summary,
    startedAt: new Date(s.state.startedAt),
    finishedAt: new Date(s.state.completedAt),
  }
  return renderSpecialistThread(reply)
}

export function renderSpecialistFailed(s: SpecialistEntry): RenderedMessage {
  if (s.state.status !== 'failed') {
    return { text: '', blocks: [] }
  }
  const reply: SpecialistThreadReply = {
    specialistName: s.name,
    status: 'failed',
    summary: s.state.error,
    errorMessage: s.state.error,
    startedAt: new Date(s.state.startedAt),
    finishedAt: new Date(s.state.failedAt),
  }
  return renderSpecialistThread(reply)
}

// ────────────────────────────────────────────────────────────────────────────
// Final report — posted in the anchor thread when the aggregator finishes
// ────────────────────────────────────────────────────────────────────────────

export function renderFinalReport(report: string, clientName: string): RenderedMessage {
  const reply: FinalReportThreadReply = {
    headline: `${clientName} — Final report`,
    sections: [{ body: report }],
  }
  return renderFinalReportThread(reply)
}

// ────────────────────────────────────────────────────────────────────────────
// Approval messages — non-threaded, posted directly to the channel.
//
// The agent-shell's internal ApprovalRequestInput / ApprovalResolvedInput
// shapes don't match the block builders' shapes 1:1, so we adapt here.
// `tenantId` is used as the display name fallback — fine for tarino-style
// slugs, but can be replaced with a tenant-name lookup later if richer
// display is needed.
// ────────────────────────────────────────────────────────────────────────────

export function renderApprovalRequest(input: ApprovalRequestInput): RenderedMessage {
  const req: ApprovalRequest = {
    tenantName: input.tenantId,
    runId: input.taskId,
    summary: `${input.toolName} requested (${input.riskLevel} risk)`,
    detail: input.riskReason,
    actionKind: 'other',
    requestedAt: new Date(),
    approvalId: input.approvalId,
  }
  return renderApprovalRequestBlocks(req)
}

export function renderApprovalResolved(input: ApprovalResolvedInput): RenderedMessage {
  // The block builder's resolution doesn't have a 'timeout' variant —
  // map it to 'deferred' since that's what timeouts effectively are
  // from a decision-tracking perspective.
  const resolution: 'approved' | 'rejected' | 'deferred' =
    input.decision === 'approved' ? 'approved' :
    input.decision === 'rejected' ? 'rejected' :
    'deferred'

  const res: ApprovalResolution = {
    tenantName: input.tenantId,
    summary: input.toolName,
    resolution,
    // resolvedBy is required on the block builder; auto-resolved
    // (timeout) and missing-resolver cases get a placeholder.
    resolvedBy: input.resolvedBy ?? '_system_',
    resolvedAt: new Date(),
    comment: input.rejectionReason,
  }
  return renderApprovalResolvedBlocks(res)
}

// ────────────────────────────────────────────────────────────────────────────
// Budget warning — non-threaded. Inline blocks; small message, rare event.
// ────────────────────────────────────────────────────────────────────────────

export function renderBudgetWarning(input: BudgetWarningInput): RenderedMessage {
  const title = `Token budget reached for ${input.clientName}`
  const blocks = [
    header(`⚠️ ${title}`),
    section(
      `*Spent:* ${input.spent.toLocaleString()}\n*Cap:* ${input.cap.toLocaleString()}`
    ),
    section(
      `Task \`${input.taskId}\` paused. Increase the per-run cap on the tenant or wait until next reset.`
    ),
    context([`Task \`${input.taskId}\``]),
  ]
  return {
    text: fallbackText({
      title,
      summary: `task ${input.taskId} paused`,
    }),
    blocks,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers preserved for any downstream callers / tests
// ────────────────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
