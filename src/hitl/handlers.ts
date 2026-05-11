// src/hitl/handlers.ts
//
// Bolt action handler functions for the HITL approval buttons.

import type { WebClient } from '@slack/web-api';
import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../logger';
import {
  getApproval,
  resolveApproval,
  type ApprovalRow,
} from './state-store';

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

  await enqueueApprovalExecution(approval).catch((err) => {
    logger.error('approval_execute_enqueue_failed', {
      approvalId: ctx.approvalId, err: String(err),
    });
  });
}

export async function handleReject(ctx: ActionContext): Promise<void> {
  const approval = await getApproval(pool(), ctx.approvalId);
  if (!approval || approval.status !== 'pending') return;

  const resolved = await resolveApproval(pool(), {
    approvalId: ctx.approvalId,
    decision:   'rejected',
    resolvedBy: ctx.slackUserId,
  });
  if (!resolved) return;

  await editMessageToResolved(ctx, resolved, 'rejected');
}

export async function handleDefer24h(ctx: ActionContext): Promise<void> {
  const approval = await getApproval(pool(), ctx.approvalId);
  if (!approval || approval.status !== 'pending') return;

  const deferUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await resolveApproval(pool(), {
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
