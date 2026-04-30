import { Worker, Job } from 'bullmq'
import { config }    from '../config'
import { AgentJob }  from '../types'
import { getTenant } from '../tenants/registry'
import { runOrchestrator }  from '../orchestrator/index'
import { runSubagent }      from '../agents/subagent'
import { runAggregator }    from '../orchestrator/aggregator'
import { postToSlack }      from '../tenants/slackManager'
import { getTokenSpend }    from '../memory/postgres'
import { logger }           from '../logger'

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD }

const worker = new Worker<AgentJob>(
  'agent-jobs',
  async (job: Job<AgentJob>) => {
    const { jobType, task, subTaskId } = job.data
    const tenant = await getTenant(task.tenantId)
    const post   = (text: string) => postToSlack(task.tenantId, task.slackChannelId, text)

    logger.info('job_processing', { jobType, tenantId: task.tenantId, taskId: task.id, subTaskId })

    // Token budget guard (only on orchestration entry point)
    if (jobType === 'orchestrate') {
      const spent = await getTokenSpend(task.agentType, task.tenantId)
      if (spent > tenant.tokenBudgetPerRun) {
        await post(`⚠️ Token budget reached for *${tenant.clientName}*. Task \`${task.id}\` paused.`)
        return
      }
      await post(`🚀 *${tenant.clientName}* — starting *${tenant.agentType}* on:\n>${task.prompt}\n\nPlanning your specialist team…`)
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
      if (jobType !== 'subagent') {
        // Don't spam Slack on individual subagent failures — aggregator handles degraded results
        await post(`❌ Task \`${task.id}\` (${jobType}) failed:\n\`\`\`${String(err).slice(0, 400)}\`\`\``)
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
