import { App } from '@slack/bolt'
import { TenantConfig } from './types'
import { listActiveTenants, getTenant } from './registry'
import { enqueueTask } from '../queue/producer'
import { getRunHistory } from '../memory/postgres'
import { getQueueMetrics } from '../queue/producer'
import { logger } from '../logger'
import { registerHitlActionHandlers } from '../hitl'

/**
 * Map of tenantId → running Slack App instance. Exported so `core/slack`
 * (the SlackPresenter) can post on behalf of each tenant's bot. The Map
 * itself is mutated as bots boot/restart; consumers should look up at call
 * time rather than caching values.
 */
// Phase 9c-fix: apps Map moved to its own module to break the circular
// import that crashed the SlackPresenter. See apps-registry.ts for why.
import { apps } from './apps-registry'
export { apps }

export async function startAllTenantBots() {
  const rows = await listActiveTenants()
  logger.info('starting_tenant_bots', { count: rows.length })

  for (const row of rows) {
    try {
      const tenant = await getTenant(row.tenant_id)
      await startTenantBot(tenant)
    } catch (err) {
      // One failing tenant must not block others
      logger.error('tenant_bot_failed_to_start', { tenantId: row.tenant_id, err: String(err) })
    }
  }
}

export async function startTenantBot(tenant: TenantConfig) {
  // Gracefully replace if already running
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
      trigger:        'slack-mention',
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
          trigger:        'slack-command',
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

  registerHitlActionHandlers(app)

  // Phase 9f: catch Bolt-level errors before they propagate as uncaught.
  // Logged with tenant context so we can attribute socket noise to the
  // right tenant when investigating.
  app.error(async (error: Error) => {
    logger.error('slack_bolt_error', {
      tenantId: tenant.tenantId,
      msg:      error.message,
      stack:    error.stack?.slice(0, 1500),
    })
  })

  await app.start()
  apps.set(tenant.tenantId, app)
  logger.info('tenant_bot_started', { tenantId: tenant.tenantId, client: tenant.clientName })
}

/**
 * @deprecated Prefer `import { presenter } from '../core/slack'` and its
 * lifecycle methods (startRun, recordSpecialistComplete, etc). This raw
 * post is kept as an escape hatch for code paths that haven't migrated;
 * new call sites should not use it.
 */
export async function postToSlack(tenantId: string, channelId: string, text: string) {
  const app = apps.get(tenantId)
  if (!app) { logger.warn('no_bot_for_tenant', { tenantId }); return }
  try {
    await app.client.chat.postMessage({ channel: channelId, text, unfurl_links: false })
  } catch (err) {
    logger.error('slack_post_failed', { tenantId, channelId, err: String(err) })
  }
}
