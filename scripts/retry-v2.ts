import { Queue } from 'bullmq'
import { Pool } from 'pg'
import { config } from '../src/config'
import { onApprovalApproved } from '../src/hitl/execution-hook'

;(async () => {
  const queue = new Queue('approval-execution', {
    connection: {
      url:                  process.env.REDIS_URL,
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
      tls:                  {},
      family:               0,
    },
  })

  const pool = new Pool({ connectionString: config.DATABASE_URL })

  const { rows } = await pool.query(
    `SELECT id, tool_name FROM approval_requests 
     WHERE tenant_id = 'tarino' 
       AND requested_at > NOW() - INTERVAL '3 days'
       AND status = 'approved' 
       AND executed_at IS NULL`
  )

  console.log(`Found ${rows.length} approvals needing re-execution:`)
  for (const r of rows) console.log(`  ${r.tool_name} (${r.id})`)

  console.log('\nClearing stale BullMQ jobs...')
  for (const r of rows) {
    const jobId = `${r.id}__${r.tool_name}`
    try {
      const existing = await queue.getJob(jobId)
      if (existing) {
        const state = await existing.getState()
        console.log(`  Removing ${jobId} (state: ${state})`)
        await existing.remove()
      } else {
        console.log(`  No stale job for ${jobId}`)
      }
    } catch (err) {
      console.log(`  Could not check ${jobId}: ${String(err).slice(0, 100)}`)
    }
  }

  console.log('\nRe-enqueueing...')
  for (const r of rows) {
    const result = await onApprovalApproved(r.id)
    console.log(`  ${r.tool_name}: ${JSON.stringify(result)}`)
  }

  console.log('\nDone. Watch Cloud Run logs and Slack.')
  await queue.close()
  process.exit(0)
})().catch((err) => {
  console.error('retry-v2 failed:', err)
  process.exit(1)
})
