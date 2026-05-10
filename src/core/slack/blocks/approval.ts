// src/core/slack/blocks/approval.ts
//
// HITL approval request. Posted as a non-threaded channel message so it's
// visible at the channel root. Includes Approve / Reject action buttons
// wired to the existing slack interactivity handler.

import type { KnownBlock } from '@slack/web-api';
import {
  header,
  section,
  context,
  divider,
  actions,
  fallbackText,
  truncate,
  formatRelative,
  compact,
  capBlocks,
} from './shared';
import type { RenderedMessage } from './types';

export interface ApprovalRequest {
  tenantName: string;
  runId: string;
  /** Short summary — one line, what's being requested. */
  summary: string;
  /** Detail — mrkdwn body explaining the change, risk, what'll happen on approve. */
  detail: string;
  /** What kind of action is this? Used for the icon and button labelling. */
  actionKind: ApprovalActionKind;
  /** Diff or preview link, optional. */
  previewUrl?: string;
  /** When the request was raised — drives "pending Xm ago". */
  requestedAt: Date;
  /** Used as the action button value to route the user's choice back. */
  approvalId: string;
}

export type ApprovalActionKind =
  | 'publish_content'
  | 'modify_live_page'
  | 'send_external_message'
  | 'commit_data_change'
  | 'other';

export function renderApprovalRequest(req: ApprovalRequest): RenderedMessage {
  const icon = approvalIcon(req.actionKind);
  const headline = `${icon}  Approval needed — ${req.tenantName}`;

  const blocks = compact<KnownBlock>([
    header(headline),
    section(`*${truncate(req.summary, 200)}*`),
    section(truncate(req.detail, 2800)),

    req.previewUrl && context([`<${req.previewUrl}|View preview ↗>`]),

    divider(),

    actions(`approval:${req.approvalId}`, [
      {
        actionId: 'approval_approve',
        text: approveButtonLabel(req.actionKind),
        value: req.approvalId,
        style: 'primary',
      },
      {
        actionId: 'approval_reject',
        text: 'Reject',
        value: req.approvalId,
        style: 'danger',
      },
      {
        actionId: 'approval_defer',
        text: 'Defer',
        value: req.approvalId,
      },
    ]),

    context([
      `Run \`${req.runId.slice(0, 8)}\``,
      `Pending ${formatRelative(req.requestedAt)}`,
    ]),
  ]);

  return {
    text: fallbackText({ title: headline, summary: req.summary }),
    blocks: capBlocks(blocks),
  };
}

/**
 * Posted as a follow-up edit when an approval is resolved (approved/rejected/deferred).
 * Replaces the original approval message in place so the channel doesn't fill
 * up with stale buttons.
 */
export interface ApprovalResolution {
  tenantName: string;
  summary: string;
  resolution: 'approved' | 'rejected' | 'deferred';
  resolvedBy: string;          // Slack user mention "<@U123>"
  resolvedAt: Date;
  comment?: string;
}

export function renderApprovalResolved(res: ApprovalResolution): RenderedMessage {
  const icon = res.resolution === 'approved'
    ? ':white_check_mark:'
    : res.resolution === 'rejected'
      ? ':no_entry_sign:'
      : ':hourglass:';

  const verb = res.resolution === 'approved'
    ? 'approved'
    : res.resolution === 'rejected'
      ? 'rejected'
      : 'deferred';

  const headline = `${icon}  ${res.tenantName} — ${verb}`;

  const blocks = compact<KnownBlock>([
    section(`*${headline}*\n${truncate(res.summary, 500)}`),
    res.comment && context([`> ${truncate(res.comment, 500)}`]),
    context([
      `${verb.charAt(0).toUpperCase() + verb.slice(1)} by ${res.resolvedBy}`,
      formatRelative(res.resolvedAt),
    ]),
  ]);

  return {
    text: fallbackText({ title: headline, summary: res.summary }),
    blocks: capBlocks(blocks),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function approvalIcon(kind: ApprovalActionKind): string {
  switch (kind) {
    case 'publish_content':       return ':rocket:';
    case 'modify_live_page':      return ':pencil2:';
    case 'send_external_message': return ':envelope:';
    case 'commit_data_change':    return ':floppy_disk:';
    case 'other':                 return ':warning:';
  }
}

function approveButtonLabel(kind: ApprovalActionKind): string {
  switch (kind) {
    case 'publish_content':       return 'Approve & publish';
    case 'modify_live_page':      return 'Approve change';
    case 'send_external_message': return 'Approve & send';
    case 'commit_data_change':    return 'Approve';
    case 'other':                 return 'Approve';
  }
}
