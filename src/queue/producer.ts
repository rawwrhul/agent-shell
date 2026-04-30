import { Queue }    from 'bullmq'
import { v4 as uuid } from 'uuid'
import { config }   from '../config'
import { AgentTask, AgentJob } from '../types'
import { logger }   from '../logger'

const connection = { host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD }

export const agentQueue = new Queue<AgentJob>('agent-jobs', {
  connection,
  defaultJobOptions: {
    attempts: 3, backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 }, removeOnFail: { count: 50 },
  },
})

export async function enqueueTask(params: {
  tenantId: string; agentType: string; prompt: string
  slackChannelId: string; slackUserId: string
  metadata?: Record<string, unknown>; priority?: number
}): Promise<AgentTask> {
  const task: AgentTask = {
    id: uuid(), tenantId: params.tenantId, agentType: params.agentType,
    prompt: params.prompt, slackChannelId: params.slackChannelId,
    slackUserId: params.slackUserId, metadata: params.metadata, createdAt: new Date(),
  }
  await agentQueue.add('orchestrate', { jobType: 'orchestrate', task } as AgentJob,
    { priority: params.priority ?? 5, jobId: task.id })
  logger.info('task_enqueued', { tenantId: params.tenantId, taskId: task.id })
  return task
}

export async function enqueueSubagentJob(params: { task: AgentTask; subTaskId: string; priority?: number }) {
  await agentQueue.add('subagent',
    { jobType: 'subagent', task: params.task, subTaskId: params.subTaskId } as AgentJob,
    { priority: params.priority ?? 5 })
  logger.info('subagent_enqueued', { taskId: params.task.id, subTaskId: params.subTaskId })
}

// jobId dedup ensures only one aggregation job fires even if two subagents complete simultaneously
export async function enqueueAggregationJob(task: AgentTask) {
  await agentQueue.add('aggregate',
    { jobType: 'aggregate', task } as AgentJob,
    { jobId: `aggregate-${task.id}`, priority: 1 })
  logger.info('aggregation_enqueued', { taskId: task.id })
}

export async function getQueueMetrics() {
  const [waiting, active, completed, failed] = await Promise.all([
    agentQueue.getWaitingCount(), agentQueue.getActiveCount(),
    agentQueue.getCompletedCount(), agentQueue.getFailedCount(),
  ])
  return { waiting, active, completed, failed }
}
