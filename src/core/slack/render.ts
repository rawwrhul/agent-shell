// src/core/slack/render.ts
//
// Rollout 2: pure rendering of RunState → Block Kit RenderedMessage.
// Rollout 3: when state.finalReport is structured (R3 shape), pass it
// through to the anchor renderer instead of just the summary string —
// the anchor renderer handles delegation to ad-hoc / daily / weekly.

import type {
  RunState, SpecialistEntry,
  ApprovalRequestInput, ApprovalResolvedInput, BudgetWarningInput,
  ExecutionResultInput,
  PendingNudgeInput,
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
  // Task 0.5.1 polish: use caller-provided fields when present, fall back to
  // sensible defaults derived from the input. The previous adapter used
  // tenantId literally for headline ("Approval needed — tarino") and the
  // raw tool name in backticks for summary, both of which read like CLI
  // output rather than a colleague's message.
  const tenantName = input.tenantName ?? input.tenantId
  const summary = input.summary
    ?? `\`${input.toolName}\` requested (${input.riskLevel} risk)`
  const actionKind = input.actionKind ?? inferActionKind(input.toolName)

  const req: ApprovalRequest = {
    tenantName,
    runId: input.taskId,
    summary,
    detail: input.riskReason,
    actionKind,
    previewUrl: input.previewUrl,
    requestedAt: new Date(),
    approvalId: input.approvalId,
  };
  return renderApprovalRequestBlocks(req);
}

/**
 * Best-effort mapping from tool name to ApprovalActionKind. Drives the
 * approval card's icon and button labels. Callers that know better can
 * pass `actionKind` explicitly on ApprovalRequestInput to override.
 */
function inferActionKind(toolName: string): import('./blocks/approval').ApprovalActionKind {
  const n = toolName.toLowerCase()
  // Framer page operations + GSC submission = publishing content
  if (n.startsWith('framer_create_draft_page')) return 'publish_content'
  if (n.startsWith('framer_update_page_draft')) return 'publish_content'
  if (n.startsWith('framer_publish'))            return 'publish_content'
  if (n.startsWith('framer_deploy'))             return 'publish_content'
  if (n.startsWith('framer_update_page_seo'))    return 'modify_live_page'
  if (n.startsWith('framer_update_cms'))         return 'modify_live_page'
  if (n.startsWith('framer_'))                   return 'modify_live_page'
  if (n.startsWith('gsc_submit') || n.startsWith('gsc_request')) return 'publish_content'
  // Outreach-type
  if (n.startsWith('email_') || n.startsWith('send_') || n.startsWith('slack_post'))
    return 'send_external_message'
  // Internal data writes
  if (n.startsWith('log_') || n.startsWith('upsert_') || n.startsWith('snapshot_'))
    return 'commit_data_change'
  return 'other'
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

// ── Execution result (Task 0.5.1) ───────────────────────────────────
//
// Posted after the executor worker has actually performed an approved
// action. Closes the loop after the operator clicks Approve — without
// this, the experience is "Approved" then silence. With it, the operator
// sees what shipped (or what failed).

export function renderExecutionResult(input: ExecutionResultInput): RenderedMessage {
  const tenantName = input.tenantName ?? input.tenantId
  const icon = input.ok ? ':white_check_mark:' : ':x:'
  const verb = input.ok ? 'Done' : 'Couldn\'t publish'
  const headline = `${icon}  ${verb} — ${tenantName}`

  const blocks: import('@slack/web-api').KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${headline}*\n${input.summary}`,
      },
    },
  ]

  if (input.ok && input.liveUrl) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `<${input.liveUrl}|View it live ↗>`,
      }],
    })
  }

  return {
    text: input.ok
      ? `Change published for ${tenantName}: ${input.summary}`
      : `Couldn't publish for ${tenantName}: ${input.summary}`,
    blocks,
  }
}

// ── Pending-too-long nudge (Task 0.5.1) ─────────────────────────────
//
// A daily background scanner finds tenants with approvals pending past
// the threshold (default 48h) and posts one of these per tenant. One
// nudge per cooldown window (24h) so we don't spam.

export function renderPendingNudge(input: PendingNudgeInput): RenderedMessage {
  const noun = input.pendingCount === 1 ? 'change' : 'changes'
  const verb = input.pendingCount === 1 ? 'is'     : 'are'
  const dayWord = input.oldestDaysAgo === 1 ? 'day' : 'days'
  const summary = input.pendingCount === 1
    ? `You have 1 change waiting on you (oldest is ${input.oldestDaysAgo} ${dayWord} old).`
    : `You have ${input.pendingCount} changes waiting on you (oldest is ${input.oldestDaysAgo} ${dayWord} old).`

  const blocks: import('@slack/web-api').KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:wave:  *Friendly nudge — ${input.tenantName}*\n${summary}`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Scroll up to find the approval cards. Each one ${verb} a small ${noun} drafted for your site that just needs a thumbs-up.`,
      }],
    },
  ]

  return {
    text: `${input.tenantName}: ${input.pendingCount} ${noun} pending`,
    blocks,
  }
}


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
