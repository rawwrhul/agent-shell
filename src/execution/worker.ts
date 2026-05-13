// src/execution/worker.ts
//
// BullMQ worker that consumes approved actions from the execution queue and
// dispatches them to the right integration handler.
//
// Lifecycle of an execution job:
//   1) Operator approves a HITL request in Slack OR Sheet OR Slack button.
//   2) HITL handler enqueues an execution job with payload:
//      { tenantId, taskId, approvalId, toolName, toolInput }
//   3) Worker picks up the job:
//      - INSERT INTO execution_jobs (status='running')
//      - dispatchExecution(toolName, toolInput, ctx)
//      - UPDATE execution_jobs (status='success'/'failed', result/error, completed_at)
//      - Update approval_requests.executed_at + executed_outcome
//      - Notify presenter so the Slack anchor updates
//
// Failures: BullMQ retries with exponential backoff. After max attempts, the
// job is moved to the failed set and execution_jobs.status = 'failed'.

import { Worker, Job } from 'bullmq'
import { Pool } from 'pg'
import { createRedisConnection } from '../lib/redis'
import { config } from '../config'
import { logger } from '../logger'
import { getTenant } from '../tenants/registry'
import { dispatchExecution } from './dispatcher'
import { presenter } from '../core/slack'
import type { IntegrationContext } from '../integrations/types'

const QUEUE_NAME = 'approval-execution'

export interface ExecutionJobPayload {
  tenantId:   string
  taskId:     string
  approvalId: string
  toolName:   string
  toolInput:  Record<string, unknown>
}

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 })
  return _pool
}

export function startExecutionWorker(): Worker {
  const worker = new Worker<ExecutionJobPayload>(
    QUEUE_NAME,
    async (job: Job<ExecutionJobPayload>) => processJob(job),
    {
      connection: {
        url:                  process.env.REDIS_URL,
        maxRetriesPerRequest: null,
        enableReadyCheck:     false,
        tls:                  {},
        family:               0,
      },
      concurrency:    Number(process.env.EXECUTION_WORKER_CONCURRENCY ?? '3'),
      stalledInterval: 30_000,
      maxStalledCount: 2,
    },
  )

  worker.on('completed', (job) => {
    logger.info('execution_job_completed', { jobId: job.id, approvalId: job.data.approvalId, toolName: job.data.toolName })
  })
  worker.on('failed', (job, err) => {
    logger.error('execution_job_failed', { jobId: job?.id, approvalId: job?.data.approvalId, toolName: job?.data.toolName, err: String(err).slice(0, 300) })
  })

  logger.info('execution_worker_started', { queue: QUEUE_NAME })
  return worker
}

async function processJob(job: Job<ExecutionJobPayload>): Promise<void> {
  const { tenantId, taskId, approvalId, toolName, toolInput } = job.data

  // 1) Insert execution_jobs row (or mark running if already created)
  await pool().query(
    `INSERT INTO execution_jobs (tenant_id, approval_id, task_id, tool_name, tool_input, status, started_at, attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'running', now(), 1)
     ON CONFLICT DO NOTHING`,
    [tenantId, approvalId, taskId, toolName, JSON.stringify(toolInput)],
  )

  // 2) Load tenant config
  const tenant = await getTenant(tenantId)
  if (!tenant) {
    await markFailed(approvalId, taskId, toolName, `tenant_not_found: ${tenantId}`)
    throw new Error(`Tenant not found: ${tenantId}`)
  }

  const ctx: IntegrationContext = { tenant, taskId, approvalId }

  // 3) Dispatch to integration handler
  let result
  try {
    result = await dispatchExecution(toolName, toolInput, ctx)
  } catch (err) {
    const errStr = String(err).slice(0, 500)
    await markFailed(approvalId, taskId, toolName, errStr)
    throw err   // surfaces to BullMQ for retry
  }

  // 4) Persist outcome
  if (result.ok) {
    await pool().query(
      `UPDATE execution_jobs
         SET status = 'success', result = $1::jsonb, completed_at = now()
       WHERE approval_id = $2 AND tool_name = $3`,
      [JSON.stringify({ summary: result.summary, detail: result.detail ?? null }), approvalId, toolName],
    )
    await pool().query(
      `UPDATE approval_requests
         SET executed_at = now(), executed_outcome = $1
       WHERE id = $2`,
      [`success: ${result.summary}`, approvalId],
    )
    logger.info('execution_success', { approvalId, toolName, summary: result.summary })

    // Task 0.5.1: post the success message to Slack so the operator sees
    // what shipped. Looks up the channel from the approval row (cron-fired
    // and ad-hoc approvals both have slack_channel_id set, defaulted to
    // tenant.slackChannelId by the seo skill).
    try {
      const { rows: approvalRows } = await pool().query<{ slack_channel_id: string | null }>(
        `SELECT slack_channel_id FROM approval_requests WHERE id = $1`, [approvalId],
      )
      const channelId = approvalRows[0]?.slack_channel_id ?? tenant.slackChannelId
      const liveUrl = extractLiveUrlFromResult(result)
      await presenter.notifyExecutionResult({
        tenantId:   tenantId,
        channelId,
        taskId,
        approvalId,
        toolName,
        ok:         true,
        summary:    result.summary,
        liveUrl,
        tenantName: tenant.clientName,
      })
    } catch (err) {
      logger.warn('presenter_notify_failed', { taskId, approvalId, err: String(err).slice(0, 200) })
    }
  } else {
    await markFailed(approvalId, taskId, toolName, result.error ?? result.summary)

    // Task 0.5.1: also post the failure message so the operator knows
    // the approved change didn't actually ship. Don't surface raw stack
    // traces — `result.summary` is the human-readable failure reason.
    try {
      const { rows: approvalRows } = await pool().query<{ slack_channel_id: string | null }>(
        `SELECT slack_channel_id FROM approval_requests WHERE id = $1`, [approvalId],
      )
      const channelId = approvalRows[0]?.slack_channel_id ?? tenant.slackChannelId
      await presenter.notifyExecutionResult({
        tenantId:   tenantId,
        channelId,
        taskId,
        approvalId,
        toolName,
        ok:         false,
        summary:    result.summary,
        tenantName: tenant.clientName,
      })
    } catch (err) {
      logger.warn('presenter_notify_failed_on_failure', { taskId, approvalId, err: String(err).slice(0, 200) })
    }
    // Surface as throw so BullMQ records the failed attempt for its retry logic
    throw new Error(`Execution failed: ${result.summary} (${result.error ?? 'no error detail'})`)
  }
}

/**
 * Best-effort extraction of a "view it live" URL from the execution
 * result. Different integrations stash this in different places — try
 * the common shapes, fall back to undefined (the result message just
 * omits the View live link in that case).
 */
function extractLiveUrlFromResult(result: { ok: boolean; summary: string; detail?: Record<string, unknown> }): string | undefined {
  const d = result.detail
  if (!d || typeof d !== 'object') return undefined
  // Framer: detail.preview.hostnames[0] (publish result)
  const preview = (d as { preview?: { hostnames?: string[] } }).preview
  if (preview?.hostnames?.[0]) return `https://${preview.hostnames[0]}/`
  // Direct fields
  if (typeof (d as { liveUrl?: string }).liveUrl === 'string') return (d as { liveUrl: string }).liveUrl
  if (typeof (d as { url?: string }).url === 'string')         return (d as { url: string }).url
  return undefined
}

async function markFailed(approvalId: string, _taskId: string, toolName: string, error: string): Promise<void> {
  await pool().query(
    `UPDATE execution_jobs
       SET status = 'failed', error = $1, completed_at = now()
     WHERE approval_id = $2 AND tool_name = $3`,
    [error, approvalId, toolName],
  )
  await pool().query(
    `UPDATE approval_requests
       SET executed_at = now(), executed_outcome = $1
     WHERE id = $2`,
    [`failed: ${error.slice(0, 200)}`, approvalId],
  )
}
