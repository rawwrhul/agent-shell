// src/hitl/index.ts
//
// Barrel + Bolt action handler registration helper.
//
// In slackManager.ts, inside startTenantBot(), after the existing
// event/command handlers are registered and BEFORE app.start():
//
//   registerHitlActionHandlers(app)
//
// Wires the four button action_ids to their handlers.

import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import {
  handleApprove,
  handleReject,
  handleDefer24h,
  handleViewDraft,
  type ActionContext,
} from './handlers';
import { logger } from '../logger';

export * from './state-store';
export * from './sheets-link';
export * from './handlers';

export function registerHitlActionHandlers(app: App): void {
  app.action<BlockAction<ButtonAction>>('approval_approve', async ({ ack, body, action, client }) => {
    await ack();
    const ctx = buildCtx(body, action, client);
    if (!ctx) return;
    await handleApprove(ctx).catch((err) =>
      logger.error('approval_approve_failed', { err: String(err) }),
    );
  });

  // Reject button: open a modal asking for the rejection reason.
  // The reason is the most valuable signal we capture from rejections — without
  // it the L2 memory hook just records '[Rejected] X. Reason: no reason given.'
  // which teaches the agent nothing. Optional field — operator can submit blank.
  app.action<BlockAction<ButtonAction>>('approval_reject', async ({ ack, body, action, client }) => {
    await ack();
    const ctx = buildCtx(body, action, client);
    if (!ctx) return;
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) {
      logger.warn('approval_reject_no_trigger_id');
      return;
    }
    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type:        'modal',
          callback_id: 'approval_reject_modal',
          private_metadata: JSON.stringify({
            approvalId:     ctx.approvalId,
            slackChannelId: ctx.slackChannelId,
            slackMessageTs: ctx.slackMessageTs,
          }),
          title:  { type: 'plain_text', text: 'Reject this?' },
          submit: { type: 'plain_text', text: 'Reject' },
          close:  { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type:     'input',
              block_id: 'reason_block',
              optional: true,
              label:    { type: 'plain_text', text: 'Why? (optional — but helps the agent learn what to avoid)' },
              element:  {
                type:        'plain_text_input',
                action_id:   'reason_input',
                multiline:   true,
                placeholder: { type: 'plain_text', text: 'e.g. "cost framing too prominent", "topic overlap with /resources/X", "image quality too low"' },
              },
            },
          ],
        },
      });
    } catch (err) {
      logger.error('approval_reject_modal_open_failed', { err: String(err) });
    }
  });

  // Modal submission: extract reason and run the actual rejection.
  app.view('approval_reject_modal', async ({ ack, body, view, client }) => {
    await ack();
    let metadata: { approvalId: string; slackChannelId: string; slackMessageTs: string };
    try {
      metadata = JSON.parse(view.private_metadata ?? '{}');
    } catch (err) {
      logger.error('approval_reject_modal_metadata_parse_failed', { err: String(err) });
      return;
    }
    if (!metadata.approvalId || !metadata.slackChannelId || !metadata.slackMessageTs) {
      logger.warn('approval_reject_modal_missing_metadata');
      return;
    }
    const reason = view.state.values?.reason_block?.reason_input?.value ?? '';
    const ctx: ActionContext = {
      approvalId:     metadata.approvalId,
      slackUserId:    body.user.id,
      slackChannelId: metadata.slackChannelId,
      slackMessageTs: metadata.slackMessageTs,
      client,
    };
    await handleReject(ctx, reason).catch((err) =>
      logger.error('approval_reject_modal_submission_failed', { err: String(err) }),
    );
  });

  app.action<BlockAction<ButtonAction>>('approval_defer', async ({ ack, body, action, client }) => {
    await ack();
    const ctx = buildCtx(body, action, client);
    if (!ctx) return;
    await handleDefer24h(ctx).catch((err) =>
      logger.error('approval_defer_failed', { err: String(err) }),
    );
  });

  app.action<BlockAction<ButtonAction>>('approval_view_draft', async ({ ack, body, action, client }) => {
    await ack();
    const ctx = buildCtx(body, action, client);
    if (!ctx) return;
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) {
      logger.warn('approval_view_draft_missing_trigger_id');
      return;
    }
    await handleViewDraft(ctx, triggerId).catch((err) =>
      logger.error('approval_view_draft_failed', { err: String(err) }),
    );
  });

  // approval_open_sheets carries a `url` so Slack handles the redirect.
  // Just ack to clear the spinner — no DB mutation needed.
  app.action<BlockAction<ButtonAction>>('approval_open_sheets', async ({ ack }) => {
    await ack();
  });
}

function buildCtx(
  body: BlockAction<ButtonAction>,
  action: ButtonAction,
  client: WebClient,
): ActionContext | null {
  const approvalId = action.value;
  const slackUserId = body.user?.id;
  const slackChannelId = body.channel?.id;
  const slackMessageTs = body.message?.ts ?? body.container?.message_ts;

  if (!approvalId || !slackUserId || !slackChannelId || !slackMessageTs) {
    logger.warn('hitl_action_missing_context', {
      hasApprovalId: !!approvalId,
      hasUser:       !!slackUserId,
      hasChannel:    !!slackChannelId,
      hasMessageTs:  !!slackMessageTs,
    });
    return null;
  }
  return { approvalId, slackUserId, slackChannelId, slackMessageTs, client };
}
