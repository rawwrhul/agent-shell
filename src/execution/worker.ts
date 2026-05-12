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
  const connection = createRedisConnection({ label: 'execution-worker' })

  const worker = new Worker<ExecutionJobPayload>(
    QUEUE_NAME,
    async (job: Job<ExecutionJobPayload>) => processJob(job),
    {
      connection,
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

    // Best-effort presenter update so the Slack anchor reflects "shipped"
    try {
      await (presenter as any).notifyExecutionResult?.(taskId, approvalId, { ok: true, summary: result.summary })
    } catch (err) {
      logger.warn('presenter_notify_failed', { taskId, approvalId, err: String(err).slice(0, 200) })
    }
  } else {
    await markFailed(approvalId, taskId, toolName, result.error ?? result.summary)
    // Surface as throw so BullMQ records the failed attempt for its retry logic
    throw new Error(`Execution failed: ${result.summary} (${result.error ?? 'no error detail'})`)
  }
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
