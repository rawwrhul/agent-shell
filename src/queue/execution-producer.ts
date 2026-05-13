// src/queue/execution-producer.ts
//
// Producer for the approval-execution queue. Call enqueueApprovalExecutionJob()
// from the HITL handler when an approval transitions to status='approved'.
//
// This file is split out from queue/producer.ts to make the merge into existing
// code easy — copy this content into queue/producer.ts, or import the function
// directly from here.

import { Queue } from 'bullmq'
import { createRedisConnection } from '../lib/redis'
import { logger } from '../logger'
import type { ExecutionJobPayload } from '../execution/worker'

const QUEUE_NAME = 'approval-execution'

let _queue: Queue | null = null
function getQueue(): Queue {
  if (_queue) return _queue
  _queue = new Queue<ExecutionJobPayload>(QUEUE_NAME, {
    connection: {
      url:                  process.env.REDIS_URL,
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
      tls:                  {},
      family:               0,
    },
    defaultJobOptions: {
      attempts:    3,
      backoff:     { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 60 * 60 * 24 * 7 },  // keep completed for 7 days
      removeOnFail:     { age: 60 * 60 * 24 * 30 }, // keep failed for 30 days for debugging
    },
  })
  return _queue
}

export async function enqueueApprovalExecutionJob(payload: ExecutionJobPayload): Promise<void> {
  await getQueue().add('execute-approval', payload, {
    jobId: `${payload.approvalId}__${payload.toolName}`, // dedup on approval+tool
  })
  logger.info('execution_job_enqueued', {
    tenantId:   payload.tenantId,
    taskId:     payload.taskId,
    approvalId: payload.approvalId,
    toolName:   payload.toolName,
  })
}
