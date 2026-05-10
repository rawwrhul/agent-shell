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

const connection = { url: process.env.REDIS_URL }

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
          await runOrchestrator(task, tenant)
          break

        case 'subagent':
          if (!subTaskId) throw new Error('subTaskId missing on subagent job')
          await runSubagent(task, subTaskId, tenant)
          break

        case 'aggregate':
          await runAggregator(task, tenant)
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
  }
)

worker.on('completed', job => logger.info('job_done', { jobId: job.id, type: job.data.jobType }))
worker.on('failed', (job, err) => logger.error('job_err', { jobId: job?.id, type: job?.data?.jobType, err: err.message }))
worker.on('error', err => logger.error('worker_error', { err: err.message }))

logger.info('worker_started', { queue: 'agent-jobs', concurrency: 8 })

export default worker
