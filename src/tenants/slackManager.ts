import { App } from '@slack/bolt'
import { TenantConfig } from './types'
import { listActiveTenants, getTenant } from './registry'
import { enqueueTask } from '../queue/producer'
import { getRunHistory } from '../memory/postgres'
import { getQueueMetrics } from '../queue/producer'
import { logger } from '../logger'
import { registerHitlActionHandlers } from '../hitl'
import { pool } from '../memory/postgres'
import { findRunByAnchorTs } from '../core/slack/state-store'
import { handleThreadFeedback } from '../feedback/handler'
import { enqueueOneOffRun } from '../scheduler'
import { matchAdHocRequest, pickForAdHoc } from '../core/opportunity-bank'

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

    // ── Secret operator command: cron simulator ─────────────────────────
    // Enqueues a one-off scheduled-run job for runKind='seo_audit'. The
    // scheduler worker picks it up and runs runFullAuditCycle identically
    // to a real cron tick (logs 'seo_audit_cycle_starting' /
    // 'seo_audit_cycle_completed'). No customer-facing Slack output — the
    // cron path is silent, and the customer experiences the audit through
    // the next daily run's Slack post. The single ack below is operator-
    // facing only so you know the trigger landed; check Cloud Run logs
    // and DB for actual progress.
    if (prompt.toLowerCase().includes('secretchrontest')) {
      // Optional runKind argument: 'secretchrontest backlink' or
      // 'secretchrontest mention'. Defaults to 'seo_audit'.
      const cronArgMatch = prompt.toLowerCase().match(/secretchrontest\s+(\w+)/)
      const requested = cronArgMatch?.[1] ?? ''
      const runKind: 'seo_audit' | 'backlink_prospect' | 'brand_mention_scan' | 'daily' | 'weekly' =
        (requested === 'backlink' || requested === 'backlink_prospect') ? 'backlink_prospect' :
        (requested === 'mention'  || requested === 'brand_mention_scan')  ? 'brand_mention_scan' :
        (requested === 'daily')   ? 'daily' :
        (requested === 'weekly')  ? 'weekly' :
        'seo_audit'
      logger.info('adhoc_audit_trigger_received', {
        tenantId: tenant.tenantId,
        userId:   event.user ?? 'unknown',
        runKind,
      })
      try {
        await enqueueOneOffRun({ tenantId: tenant.tenantId, runKind })
        await say({
          text:      `:eyes: Trigger received. Queued one-off \`${runKind}\` cycle for *${tenant.clientName}* — identical code path to the corresponding cron. Watch Cloud Run logs for \`${runKind}_cycle_completed\` (or the _from_worker variant). No further Slack output from this command.`,
          thread_ts: event.ts,
        })
      } catch (err) {
        await say({
          text:      `:x: Failed to queue audit: ${String(err).slice(0, 200)}`,
          thread_ts: event.ts,
        })
        logger.error('adhoc_audit_enqueue_failed', {
          tenantId: tenant.tenantId,
          err:      String(err).slice(0, 500),
        })
      }
      return
    }

    // ── Ad-hoc bank check ───────────────────────────────────────────────
    // If the prompt is asking about an opportunity type we track and the
    // bank has enough matching rows, serve from the bank without spinning
    // up a fresh discovery run. Otherwise fall through to the normal
    // enqueueTask flow.
    try {
      const matched = await matchAdHocRequest({ prompt })
      if (matched && matched.types.length > 0) {
        const banked = await pickForAdHoc({
          tenantId: tenant.tenantId,
          types:    matched.types,
          limit:    5,
        })
        if (banked.length >= 3) {
          logger.info('adhoc_served_from_bank', {
            tenantId: tenant.tenantId,
            types:    matched.types,
            count:    banked.length,
          })
          const lines = banked.map((o, i) =>
            `${i + 1}. [${o.priority}] ${o.type}${o.target ? ' — ' + o.target : ''}\n   ${o.description}`
          ).join('\n\n')
          await say({
            text: `Pulled ${banked.length} matching opportunities from the bank (no fresh discovery needed):\n\n${lines}\n\n_If you want a fresh search anyway, rephrase with explicit \`run a discovery\` wording._`,
            thread_ts: event.ts,
          })
          return
        }
        // Bank too thin — fall through to fresh discovery below.
        logger.info('adhoc_bank_too_thin_falling_through', {
          tenantId: tenant.tenantId,
          types:    matched.types,
          banked:   banked.length,
        })
      }
    } catch (err) {
      // Classifier or bank query failed — fall through to normal flow.
      logger.warn('adhoc_bank_check_failed', {
        tenantId: tenant.tenantId,
        err:      String(err).slice(0, 300),
      })
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

  // ── Phase 9b: thread reply → pitch refinement ──────────────────────────
  //
  // When the operator types a message in a thread anchored on one of our
  // runs, route it through the refinement handler. Bot messages and direct
  // @-mentions are filtered out so we don't react to ourselves or trigger
  // double-processing.
  app.event('message', async ({ event }) => {
    const e = event as {
      type:       string
      channel?:   string
      user?:      string
      text?:      string
      ts?:        string
      thread_ts?: string
      subtype?:   string
      bot_id?:    string
    }
    // Filter: only thread replies. Top-level messages and bot messages skip.
    if (!e.thread_ts || e.thread_ts === e.ts) return
    if (e.subtype === 'bot_message' || e.bot_id) return
    if (!e.channel || !e.user || !e.text) return
    // Filter: @-mentions are handled by app_mention — don't double-process.
    if (e.text.match(/<@[A-Z0-9]+>/)) return
    // Filter: thread anchor must belong to one of our runs.
    const run = await findRunByAnchorTs(pool, e.channel, e.thread_ts)
    if (!run || run.tenantId !== tenant.tenantId) return

    try {
      await handleThreadFeedback({
        app,
        tenantId:  tenant.tenantId,
        taskId:    run.taskId,
        channelId: e.channel,
        threadTs:  e.thread_ts,
        feedback:  e.text,
        userId:    e.user,
      })
    } catch (err) {
      logger.error('thread_feedback_handler_failed', {
        tenantId: tenant.tenantId,
        taskId:   run.taskId,
        err:      String(err).slice(0, 500),
      })
    }
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
        const runs = await getRunHistory(taskId, tenant.tenantId)
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

  registerHitlActionHandlers(app, tenant.tenantId)

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

