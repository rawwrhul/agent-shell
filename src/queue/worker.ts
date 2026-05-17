import { Worker, Job } from 'bullmq'
import { config }    from '../config'
import { AgentJob }  from '../types'
import { getTenant } from '../tenants/registry'
import { runOrchestrator }  from '../orchestrator/index'
import { runSubagent }      from '../agents/subagent'
import { runAggregator }    from '../orchestrator/aggregator'
import { presenter }        from '../core/slack'
import { getTokenSpend }    from '../memory/postgres'
import { logger }           from '../logger'
import { createRedisConnection } from '../lib/redis'

// Single shared connection for the agent-jobs worker. Configured via
// createRedisConnection for Upstash compatibility (TLS, retries, reconnect).
const connection = createRedisConnection({
  url:   process.env.REDIS_URL,
  label: 'agent-jobs-worker',
})

const worker = new Worker<AgentJob>(
  'agent-jobs',
  async (job: Job<AgentJob>) => {
    const { jobType, task, subTaskId } = job.data
    const tenant = await getTenant(task.tenantId)

    logger.info('job_processing', { jobType, tenantId: task.tenantId, taskId: task.id, subTaskId })

    // Token budget guard (only on orchestration entry point)
    if (jobType === 'orchestrate') {
      const spent = await getTokenSpend(task.agentType, task.tenantId)
      if (spent > tenant.tokenBudgetPerRun) {
        await presenter.postBudgetWarning({
          tenantId:   task.tenantId,
          channelId:  task.slackChannelId,
          taskId:     task.id,
          clientName: tenant.clientName,
          spent,
          cap:        tenant.tokenBudgetPerRun,
        })
        return
      }

      // Anchor message + slack_runs row. Once this succeeds, every downstream
      // call (orchestrator spawn announcements, subagent start/complete, the
      // aggregator's final report) updates the same anchor in place.
      await presenter.startRun({
        taskId:     task.id,
        tenantId:   task.tenantId,
        agentType:  tenant.agentType,
        clientName: tenant.clientName,
        prompt:     task.prompt,
        channelId:  task.slackChannelId,
      })
    }

    try {
      switch (jobType) {
        case 'orchestrate':
          // 5 min cap: planning is normally <1 min. If we exceed, something
          // is wrong (Anthropic stalled, DB hang, etc.) — fail fast.
          await withJobWatchdog(() => runOrchestrator(task, tenant), 5 * 60_000, 'orchestrator', task.id)
          break

        case 'subagent':
          if (!subTaskId) throw new Error('subTaskId missing on subagent job')
          // 12 min cap: clean specialists finish in ~5 min. 12 gives 2.3x
          // headroom for slow LLM responses or extra tool calls, but caps
          // the silent-hang failure mode at a bounded burn.
          await withJobWatchdog(() => runSubagent(task, subTaskId, tenant), 12 * 60_000, 'subagent', task.id)
          break

        case 'aggregate':
          // 5 min cap: synthesis LLM is already 3-min capped internally,
          // plus surfacing + Slack render. 5 min is the outer envelope.
          await withJobWatchdog(() => runAggregator(task, tenant), 5 * 60_000, 'aggregator', task.id)
          break

        default:
          throw new Error(`Unknown jobType: ${jobType}`)
      }
    } catch (err) {
      logger.error('job_failed', { jobType, taskId: task.id, subTaskId, err: String(err) })
      // Run-level failures (orchestrator throws before completion, aggregator
      // throws) flip the anchor to 'failed' with the error summary. Subagent
      // failures are surfaced individually via recordSpecialistFailure inside
      // runSubagent — we don't want one bad specialist to mark the whole run
      // failed, since the aggregator can still produce a degraded report from
      // the specialists that succeeded.
      if (jobType === 'orchestrate' || jobType === 'aggregate') {
        await presenter.failRun(task.id, String(err).slice(0, 400))
      }
      throw err
    }
  },
  {
    connection,
    concurrency: 8,  // Enough to run multiple subagents in parallel across tenants
    limiter: { max: 20, duration: 60_000 },
    // Aggregator LLM calls take 60-90s. Default lockDuration (30s) was
    // expiring mid-call → BullMQ marked jobs stalled → reassigned → 2-3x
    // parallel aggregator instances. 5min gives comfortable headroom.
    lockDuration:     300_000,
    // Don't auto-recover from "stalled" detection — if a job genuinely
    // failed to renew its lock, treat it as failed rather than retrying.
    maxStalledCount:  0,
  }
)

/**
 * Wraps a job-handler call with a hard total-execution timeout. If the
 * inner promise doesn't resolve in time, this rejects so BullMQ's catch
 * marks the job failed. Note: the underlying work may continue running
 * in the background until it either finishes naturally or the container
 * recycles — Node can't force-cancel a hung Promise. The point here is
 * to free the job slot and update Slack to a failed state rather than
 * leaving the system stuck on "running" forever.
 */
async function withJobWatchdog<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
  taskId: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          logger.error('job_watchdog_fired', { label, taskId, afterMs: ms })
          reject(new Error(`watchdog_timeout_${label}_after_${ms}ms`))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

worker.on('completed', job => logger.info('job_done', { jobId: job.id, type: job.data.jobType }))
worker.on('failed', (job, err) => logger.error('job_err', { jobId: job?.id, type: job?.data?.jobType, err: err.message }))
worker.on('error', err => logger.error('worker_error', { err: err.message }))

logger.info('worker_started', { queue: 'agent-jobs', concurrency: 8 })

export default worker
