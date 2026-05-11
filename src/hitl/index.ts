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

  app.action<BlockAction<ButtonAction>>('approval_reject', async ({ ack, body, action, client }) => {
    await ack();
    const ctx = buildCtx(body, action, client);
    if (!ctx) return;
    await handleReject(ctx).catch((err) =>
      logger.error('approval_reject_failed', { err: String(err) }),
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
