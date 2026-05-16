// src/hitl/handlers.ts
//
// Bolt action handler functions for the HITL approval buttons.
//
// R3.1 architecture:
//   - PG is the source of truth for operational state — buttons update PG
//     first; the agent's wait loop polls PG and unblocks within ~1.5s.
//   - Sheet is the persistent audit record — we mirror the PG resolution
//     to the Sheet (best-effort) so the persistent record stays accurate
//     after a Slack button click.
//   - Sheet mirroring failures are logged but never block the click flow.

import type { WebClient } from '@slack/web-api';
import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../logger';
import { onApprovalResolved } from '../memory/pipeline-events';
import {
  getApproval,
  resolveApproval,
  type ApprovalRow,
} from './state-store';
import { updateApprovalRowStatus } from './sheets';
import { getTenant } from '../tenants/registry';
import { onApprovalApproved } from './execution-hook';

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL });
  return _pool;
}

export interface ActionContext {
  approvalId:     string;
  slackUserId:    string;
  slackChannelId: string;
  slackMessageTs: string;
  client:         WebClient;
}

// ── Handlers ────────────────────────────────────────────────────────

export async function handleApprove(ctx: ActionContext): Promise<void> {
  const approval = await getApproval(pool(), ctx.approvalId);
  if (!approval) {
    await postEphemeral(ctx, "Couldn't find that approval — may have been resolved.");
    return;
  }
  if (approval.status !== 'pending') {
    await postEphemeral(ctx, `Already ${approval.status}.`);
    return;
  }

  const resolved = await resolveApproval(pool(), {
    approvalId: ctx.approvalId,
    decision:   'approved',
    resolvedBy: ctx.slackUserId,
  });
  if (!resolved) return;

  await editMessageToResolved(ctx, resolved, 'approved');

  // Mirror to Sheet (best-effort) so the persistent record stays in sync.
  await mirrorResolutionToSheet(resolved, 'approved', ctx.slackUserId).catch(() => {
    /* swallowed — mirror failures already logged inside */
  });

  // Chunk 2c: capture the terminal outcome in L2 memory.
  void onApprovalResolved({
    approvalId:     ctx.approvalId,
    tenantId:       approval.tenantId,
    toolName:       approval.toolName,
    proposedAction: approval.proposedAction,
    toolInput:      approval.toolInput,
    status:         'approved',
    resolvedBy:     ctx.slackUserId,
  })

  try {
    const r = await onApprovalApproved(ctx.approvalId);
    if (r.enqueued) {
      logger.info('execution_enqueued_from_button', { approvalId: ctx.approvalId });
    } else {
      logger.info('execution_not_enqueued', { approvalId: ctx.approvalId, reason: r.reason });
    }
  } catch (err) {
    logger.error('execution_enqueue_failed', {
      approvalId: ctx.approvalId,
      err: String(err).slice(0, 200),
    });
  }
}

export async function handleReject(ctx: ActionContext, rejectionReason?: string): Promise<void> {
  const approval = await getApproval(pool(), ctx.approvalId);
  if (!approval || approval.status !== 'pending') return;

  const resolved = await resolveApproval(pool(), {
    approvalId: ctx.approvalId,
    decision:   'rejected',
    resolvedBy: ctx.slackUserId,
    rejectionReason,
  });
  if (!resolved) return;

  await editMessageToResolved(ctx, resolved, 'rejected');

  // Mirror to Sheet (best-effort)
  await mirrorResolutionToSheet(resolved, 'rejected', ctx.slackUserId, rejectionReason).catch(() => {});

  // Chunk 2c: capture the terminal outcome (with operator's reason) in L2 memory.
  void onApprovalResolved({
    approvalId:      ctx.approvalId,
    tenantId:        approval.tenantId,
    toolName:        approval.toolName,
    proposedAction:  approval.proposedAction,
    toolInput:       approval.toolInput,
    status:          'rejected',
    resolvedBy:      ctx.slackUserId,
    rejectionReason: rejectionReason,
  })
}

export async function handleDefer24h(ctx: ActionContext): Promise<void> {
  const approval = await getApproval(pool(), ctx.approvalId);
  if (!approval || approval.status !== 'pending') return;

  const deferUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const resolved = await resolveApproval(pool(), {
    approvalId: ctx.approvalId,
    decision:   'deferred',
    resolvedBy: ctx.slackUserId,
    deferUntil,
  });

  await postEphemeral(
    ctx,
    `Deferred. Will reappear in tomorrow's daily run if not actioned.`,
  );
  logger.info('approval_deferred', {
    approvalId: ctx.approvalId, by: ctx.slackUserId, until: deferUntil.toISOString(),
  });

  // Mirror to Sheet (best-effort) — surfaces deferral on the audit record
  if (resolved) {
    await mirrorResolutionToSheet(resolved, 'deferred', ctx.slackUserId).catch(() => {});
  }
}

export async function handleViewDraft(ctx: ActionContext, triggerId: string): Promise<void> {
  const approval = await getApproval(pool(), ctx.approvalId);
  if (!approval) {
    await postEphemeral(ctx, "Couldn't find that approval.");
    return;
  }

  const draftText = formatDraftPreview(approval);
  await ctx.client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: `Approval ${approval.id.slice(0, 8)}` },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Action*\n${approval.proposedAction ?? approval.toolName}`,
          },
        },
        { type: 'divider' },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Draft / payload*\n\`\`\`${draftText}\`\`\`` },
        },
      ],
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Mirror a PG resolution back to the Sheet row so the persistent audit
 * record reflects the decision. Best-effort: any failure (Sheets API
 * down, row not found, auth issue) is logged inside updateApprovalRowStatus
 * and swallowed here. The PG row remains authoritative.
 */
async function mirrorResolutionToSheet(
  approval: ApprovalRow,
  decision: 'approved' | 'rejected' | 'deferred',
  resolvedBy: string,
  rejectionReason?: string,
): Promise<void> {
  try {
    const tenant = await getTenant(approval.tenantId);
    await updateApprovalRowStatus(tenant, {
      approvalId:      approval.id,
      rowNumber:       approval.sheetRowNumber,
      status:          decision,
      resolvedBy,
      rejectionReason,
    });
  } catch (err) {
    logger.warn('approval_sheet_mirror_tenant_lookup_failed', {
      approvalId: approval.id, tenantId: approval.tenantId,
      err: String(err).slice(0, 200),
    });
  }
}

async function editMessageToResolved(
  ctx: ActionContext,
  resolved: ApprovalRow,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const emoji = decision === 'approved' ? '✅' : '❌';
  const verb = decision === 'approved' ? 'Approved' : 'Rejected';
  const summary = resolved.proposedAction ?? resolved.toolName;

  const blocks = [
    {
      type: 'header' as const,
      text: { type: 'plain_text' as const, text: `${emoji} ${verb}`, emoji: true },
    },
    {
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: `*Action*\n${summary}` },
    },
    {
      type: 'section' as const,
      text: {
        type: 'mrkdwn' as const,
        text: `${verb} by <@${ctx.slackUserId}> at ${formatTime(new Date())}`,
      },
    },
    {
      type: 'context' as const,
      elements: [{
        type: 'mrkdwn' as const,
        text: `Tool: \`${resolved.toolName}\`  ·  ID: \`${resolved.id.slice(0, 8)}\``,
      }],
    },
  ];

  await ctx.client.chat.update({
    channel: ctx.slackChannelId,
    ts:      ctx.slackMessageTs,
    text:    `${verb} — ${summary}`,
    blocks,
  }).catch((err) => {
    logger.error('approval_message_edit_failed', {
      approvalId: ctx.approvalId, err: String(err),
    });
  });
}

async function postEphemeral(ctx: ActionContext, text: string): Promise<void> {
  await ctx.client.chat.postEphemeral({
    channel: ctx.slackChannelId,
    user:    ctx.slackUserId,
    text,
  }).catch((err) => {
    logger.warn('approval_ephemeral_failed', { err: String(err) });
  });
}

/**
 * Lazy-import + safely cast. The producer may not yet export
 * enqueueApprovalExecutionJob; if it doesn't, we log and continue —
 * the row is already resolved either way.
 */
async function enqueueApprovalExecution(approval: ApprovalRow): Promise<void> {
  type Producer = { enqueueApprovalExecutionJob?: (a: ApprovalRow) => Promise<void> };
  const mod = (await import('../queue/producer').catch(() => ({}))) as Producer;
  if (!mod.enqueueApprovalExecutionJob) {
    logger.warn('approval_execute_enqueue_unavailable', {
      approvalId: approval.id,
      hint: 'Add enqueueApprovalExecutionJob to src/queue/producer.ts',
    });
    return;
  }
  await mod.enqueueApprovalExecutionJob(approval);
}

function formatDraftPreview(approval: ApprovalRow): string {
  if (!approval.toolInput) return '(no draft attached)';
  const json = JSON.stringify(approval.toolInput, null, 2);
  return json.length > 2800 ? json.slice(0, 2799) + '…' : json;
}

function formatTime(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}
