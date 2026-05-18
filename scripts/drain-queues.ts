// scripts/drain-queues.ts
//
// Emergency stop: clears all jobs from BullMQ queues so when Cloud Run
// comes back up, no zombie work gets picked up.

import { Queue } from 'bullmq'
import { createRedisConnection } from '../src/lib/redis'
import { config } from '../src/config'

const QUEUE_NAMES = ['agent-jobs', 'scheduled-runs']

;(async () => {
  const connection = createRedisConnection({
    host:     config.REDIS_HOST,
    port:     config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    label:    'drain-queues',
  })

  for (const name of QUEUE_NAMES) {
    const queue = new Queue(name, { connection })
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')
    console.log(`\n${name} BEFORE:`, counts)

    await queue.drain(true)
    await queue.clean(0, 1000, 'failed')
    await queue.clean(0, 1000, 'completed')

    const after = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')
    console.log(`${name} AFTER:`, after)
  }

  process.exit(0)
})()
