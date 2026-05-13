import { App }      from '@slack/bolt'
import type { KnownBlock, BlockAction } from '@slack/bolt'
import { TenantConfig }   from './types'
import { listActiveTenants, getTenant } from './registry'
import { enqueueTask }    from '../queue/producer'
import { getRunHistory }  from '../memory/postgres'
import { getQueueMetrics } from '../queue/producer'
import { pool }           from '../memory/postgres'
import { logger }         from '../logger'
import { buildResolvedCard } from '../core/slack/blocks/proposal-card'
import type { ApprovalCardData } from '../core/slack/blocks/types'

const apps = new Map<string, App>()

export async function startAllTenantBots() {
  const rows = await listActiveTenants()
  logger.info('starting_tenant_bots', { count: rows.length })

  for (const row of rows) {
    try {
      const tenant = await getTenant(row.tenant_id)
      await startTenantBot(tenant)
    } catch (err) {
      logger.error('tenant_bot_failed_to_start', { tenantId: row.tenant_id, err: String(err) })
    }
  }
}

export async function startTenantBot(tenant: TenantConfig) {
  if (apps.has(tenant.tenantId)) {
    await apps.get(tenant.tenantId)!.stop()
    apps.delete(tenant.tenantId)
  }

  const app = new App({
    token:         tenant.slackBotToken,
    appToken:      tenant.slackAppToken,
    signingSecret: tenant.slackSigningSecret,
    socketMode:    true,
  })

  // ── @mention → enqueue task ──────────────────────────────────────────────
  app.event('app_mention', async ({ event, say }) => {
    const prompt = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()

    if (!prompt) {
      await say({
        text: `Hi! Mention me with a task. Example:\n\`@bot run an SEO audit on example.com\``,
        thread_ts: event.ts,
      })
      return
    }

    const task = await enqueueTask({
      tenantId:       tenant.tenantId,
      agentType:      tenant.agentType,
      prompt,
      slackChannelId: event.channel,
      slackUserId:    event.user ?? 'unknown',
    })

    await say({
      text: `Got it! Starting your *${tenant.agentType}* agent.\n*Task ID:* \`${task.id}\`\nI'll post updates here as I progress.`,
      thread_ts: event.ts,
    })

    logger.info('task_triggered_via_slack', { tenantId: tenant.tenantId, taskId: task.id })
  })

  // ── /agent command ───────────────────────────────────────────────────────
  app.command('/agent', async ({ command, ack, respond }) => {
    await ack()
    const [sub, ...rest] = command.text.trim().split(' ')

    switch (sub) {
      case 'run': {
        const prompt = rest.join(' ')
        if (!prompt) { await respond('Usage: `/agent run <task description>`'); return }
        const task = await enqueueTask({
          tenantId:       tenant.tenantId,
          agentType:      tenant.agentType,
          prompt,
          slackChannelId: command.channel_id,
          slackUserId:    command.user_id,
        })
        await respond({
          text: `✅ Task queued\n*Agent:* ${tenant.agentType}\n*Task ID:* \`${task.id}\``,
          response_type: 'in_channel',
        })
        break
      }

      case 'status': {
        const m = await getQueueMetrics()
        await respond(`*Queue status*\n• Waiting: ${m.waiting}\n• Active: ${m.active}\n• Completed: ${m.completed}\n• Failed: ${m.failed}`)
        break
      }

      case 'history': {
        const taskId = rest[0]
        if (!taskId) { await respond('Usage: `/agent history <task-id>`'); return }
        const runs = await getRunHistory(taskId)
        if (!runs.length) { await respond(`No history for \`${taskId}\``); return }
        const lines = runs.map((r, i) =>
          `• Session ${i + 1}: ${r.status} | ${r.tokenCount.toLocaleString()} tokens | ${r.summary ?? 'no summary'}`
        )
        await respond(`*History for \`${taskId}\`*\n${lines.join('\n')}`)
        break
      }

      default:
        await respond('Commands: `run <task>` · `status` · `history <task-id>`')
    }
  })

  // ── Approval card actions ─────────────────────────────────────────────────

  app.action('approve_action', async ({ body, ack, client }) => {
    await ack()
    const blockBody = body as BlockAction
    const action = blockBody.actions[0]
    if (!action || action.type !== 'button') return

    const approvalId = (action as { value?: string }).value
    if (!approvalId) return
    const resolvedBy = blockBody.user.id
    const resolvedAt = new Date()

    try {
      await resolveApprovalRequest(approvalId, 'approved', resolvedBy, resolvedAt, client, tenant)
    } catch (err) {
      logger.error('approve_action_failed', { approvalId, err: String(err).slice(0, 200) })
    }
  })

  app.action('reject_action', async ({ body, ack, client }) => {
    await ack()
    const blockBody = body as BlockAction
    const action = blockBody.actions[0]
    if (!action || action.type !== 'button') return

    const approvalId = (action as { value?: string }).value
    if (!approvalId) return
    const resolvedBy = blockBody.user.id
    const resolvedAt = new Date()

    try {
      await resolveApprovalRequest(approvalId, 'rejected', resolvedBy, resolvedAt, client, tenant)
    } catch (err) {
      logger.error('reject_action_failed', { approvalId, err: String(err).slice(0, 200) })
    }
  })

  await app.start()
  apps.set(tenant.tenantId, app)
  logger.info('tenant_bot_started', { tenantId: tenant.tenantId, client: tenant.clientName })
}

// ── Approval resolution ───────────────────────────────────────────────────

async function resolveApprovalRequest(
  approvalId: string,
  status: 'approved' | 'rejected',
  resolvedBy: string,
  resolvedAt: Date,
  client: App['client'],
  tenant: TenantConfig,
): Promise<void> {
  const res = await pool.query<{
    id: string; tool_name: string; tool_input: Record<string, unknown>
    risk_level: string; requested_at: Date
    slack_message_ts: string | null; slack_channel_id: string | null
  }>(
    `UPDATE approval_requests
     SET status=$2, resolved_by=$3, resolved_at=$4
     WHERE id=$1 AND status='pending'
     RETURNING id, tool_name, tool_input, risk_level, requested_at,
               slack_message_ts, slack_channel_id`,
    [approvalId, status, resolvedBy, resolvedAt],
  )

  if (!res.rows.length) {
    logger.warn('approval_resolve_not_found_or_already_resolved', { approvalId })
    return
  }

  const row = res.rows[0]
  const ti  = row.tool_input
  const toolName      = row.tool_name
  const proposedAction = typeof ti?.proposedAction === 'string' ? ti.proposedAction : toolName
  const whyPriority   = typeof ti?.whyPriority    === 'string' ? ti.whyPriority    : ''

  const riskLevel = (['low', 'medium', 'high', 'critical'].includes(row.risk_level)
    ? row.risk_level : 'medium') as 'low' | 'medium' | 'high' | 'critical'

  logger.info('approval_resolved', { approvalId, status, resolvedBy, tenantId: tenant.tenantId })

  // Update the original Slack card to show the resolved state
  if (row.slack_message_ts && row.slack_channel_id) {
    const cardData: ApprovalCardData = {
      approvalId,
      toolName,
      proposedAction,
      whyPriority,
      riskLevel,
      requestedAt:    row.requested_at,
      specialistType: '',
    }
    const resolvedBlocks = buildResolvedCard(cardData, { status, resolvedBy, resolvedAt })

    try {
      await client.chat.update({
        channel: row.slack_channel_id,
        ts:      row.slack_message_ts,
        blocks:  resolvedBlocks,
        text:    status === 'approved'
          ? `✅ Approved: ${proposedAction}`
          : `❌ Rejected: ${proposedAction}`,
      })
    } catch (err) {
      logger.warn('approval_card_update_failed', { approvalId, err: String(err).slice(0, 200) })
    }
  }
}

// ── Slack message posting ─────────────────────────────────────────────────

export async function postToSlack(tenantId: string, channelId: string, text: string) {
  const app = apps.get(tenantId)
  if (!app) { logger.warn('no_bot_for_tenant', { tenantId }); return }
  try {
    await app.client.chat.postMessage({ channel: channelId, text, unfurl_links: false })
  } catch (err) {
    logger.error('slack_post_failed', { tenantId, channelId, err: String(err) })
  }
}

/**
 * Post a Block Kit message and return the message timestamp.
 * The ts is stored in approval_requests.slack_message_ts so the card
 * can be updated when the operator approves or rejects.
 */
export async function postBlocksToSlack(
  tenantId:     string,
  channelId:    string,
  blocks:       KnownBlock[],
  fallbackText: string,
): Promise<string | undefined> {
  const app = apps.get(tenantId)
  if (!app) {
    logger.warn('no_bot_for_tenant', { tenantId })
    return undefined
  }
  try {
    const res = await app.client.chat.postMessage({
      channel:      channelId,
      blocks,
      text:         fallbackText,
      unfurl_links: false,
    })
    return res.ts as string | undefined
  } catch (err) {
    logger.error('slack_blocks_post_failed', { tenantId, channelId, err: String(err) })
    return undefined
  }
}
