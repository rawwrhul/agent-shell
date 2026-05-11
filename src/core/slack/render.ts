// src/core/slack/render.ts
//
// Rollout 2: pure rendering of RunState → Block Kit RenderedMessage.
// Rollout 3: when state.finalReport is structured (R3 shape), pass it
// through to the anchor renderer instead of just the summary string —
// the anchor renderer handles delegation to ad-hoc / daily / weekly.

import type {
  RunState, SpecialistEntry,
  ApprovalRequestInput, ApprovalResolvedInput, BudgetWarningInput,
} from './types';
import { isStructuredReport } from './types';
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
  type FinalReport,
} from './blocks';
import { header, section, context, fallbackText } from './blocks/shared';

// ── Anchor ──────────────────────────────────────────────────────────

export function renderAnchor(state: RunState): RenderedMessage {
  return renderAnchorBlocks(adaptRunStateToAnchor(state));
}

function adaptRunStateToAnchor(state: RunState): AnchorState {
  const specialists = Object.values(state.specialists).map(adaptSpecialist);

  // R3: narrow finalReport into structured vs legacy via type guard.
  let finalReport: FinalReport | undefined;
  let finalSummary: string | undefined;
  if (state.finalReport) {
    if (isStructuredReport(state.finalReport)) {
      // Discard the marker prop — AnchorState.finalReport only wants FinalReport
      const { renderedInAnchor: _r, ...rest } = state.finalReport;
      finalReport = rest as FinalReport;
    } else if (state.phase === 'complete') {
      finalSummary = state.finalReport.summaryText;
    }
  }

  return {
    tenantName: state.clientName,
    runId: state.taskId,
    phase: state.phase,
    startedAt: new Date(state.startedAt),
    updatedAt: new Date(),
    prompt: state.prompt,
    planSummary: state.planSummary,
    specialists,
    finalReport,                     // R3: structured shape, anchor delegates
    finalSummary,                    // legacy: summary string fallback
    errorMessage: state.errorSummary,
  };
}

function adaptSpecialist(s: SpecialistEntry): SpecialistState {
  switch (s.state.status) {
    case 'queued':
      return { id: s.type, name: s.name, status: 'pending' };
    case 'running':
      return {
        id: s.type,
        name: s.name,
        status: 'in_progress',
        startedAt: new Date(s.state.startedAt),
        summary: s.state.lastNote,
      };
    case 'complete':
      return {
        id: s.type,
        name: s.name,
        status: 'done',
        startedAt: new Date(s.state.startedAt),
        finishedAt: new Date(s.state.completedAt),
        summary: s.state.summary,
      };
    case 'failed':
      return {
        id: s.type,
        name: s.name,
        status: 'failed',
        startedAt: new Date(s.state.startedAt),
        finishedAt: new Date(s.state.failedAt),
        summary: s.state.error,
      };
  }
}

// ── Thread posts — per-specialist completion or failure ─────────────

export function renderSpecialistComplete(s: SpecialistEntry): RenderedMessage {
  if (s.state.status !== 'complete') {
    return { text: '', blocks: [] };
  }
  const reply: SpecialistThreadReply = {
    specialistName: s.name,
    status: 'done',
    summary: s.state.summary,
    startedAt: new Date(s.state.startedAt),
    finishedAt: new Date(s.state.completedAt),
  };
  return renderSpecialistThread(reply);
}

export function renderSpecialistFailed(s: SpecialistEntry): RenderedMessage {
  if (s.state.status !== 'failed') {
    return { text: '', blocks: [] };
  }
  const reply: SpecialistThreadReply = {
    specialistName: s.name,
    status: 'failed',
    summary: s.state.error,
    errorMessage: s.state.error,
    startedAt: new Date(s.state.startedAt),
    finishedAt: new Date(s.state.failedAt),
  };
  return renderSpecialistThread(reply);
}

// ── Final report (legacy markdown path) ─────────────────────────────

export function renderFinalReport(report: string, clientName: string): RenderedMessage {
  const reply: FinalReportThreadReply = {
    headline: `${clientName} — Final report`,
    sections: [{ body: report }],
  };
  return renderFinalReportThread(reply);
}

// ── Approval messages ───────────────────────────────────────────────

export function renderApprovalRequest(input: ApprovalRequestInput): RenderedMessage {
  const req: ApprovalRequest = {
    tenantName: input.tenantId,
    runId: input.taskId,
    summary: `${input.toolName} requested (${input.riskLevel} risk)`,
    detail: input.riskReason,
    actionKind: 'other',
    requestedAt: new Date(),
    approvalId: input.approvalId,
  };
  return renderApprovalRequestBlocks(req);
}

export function renderApprovalResolved(input: ApprovalResolvedInput): RenderedMessage {
  const resolution: 'approved' | 'rejected' | 'deferred' =
    input.decision === 'approved' ? 'approved' :
    input.decision === 'rejected' ? 'rejected' :
    'deferred';

  const res: ApprovalResolution = {
    tenantName: input.tenantId,
    summary: input.toolName,
    resolution,
    resolvedBy: input.resolvedBy ?? '_system_',
    resolvedAt: new Date(),
    comment: input.rejectionReason,
  };
  return renderApprovalResolvedBlocks(res);
}

// ── Budget warning ──────────────────────────────────────────────────

export function renderBudgetWarning(input: BudgetWarningInput): RenderedMessage {
  const title = `Token budget reached for ${input.clientName}`;
  const blocks = [
    header(`⚠️ ${title}`),
    section(
      `*Spent:* ${input.spent.toLocaleString()}\n*Cap:* ${input.cap.toLocaleString()}`
    ),
    section(
      `Task \`${input.taskId}\` paused. Increase the per-run cap on the tenant or wait until next reset.`
    ),
    context([`Task \`${input.taskId}\``]),
  ];
  return {
    text: fallbackText({ title, summary: `task ${input.taskId} paused` }),
    blocks,
  };
}

// ── Helpers preserved for downstream callers / tests ────────────────

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
