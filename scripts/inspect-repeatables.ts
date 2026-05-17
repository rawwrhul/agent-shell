// scripts/inspect-repeatables.ts
//
// Lists every BullMQ repeatable currently registered in Upstash for the
// scheduled-runs queue. For each one, prompts whether to remove it.
//
// Use this to find and kill stale repeatables — most commonly the
// every-day-9am daily that survived a cron expression change.
//
// Usage:
//   npx tsx scripts/inspect-repeatables.ts
//   npx tsx scripts/inspect-repeatables.ts --dry-run    (no prompts, just list)
//   npx tsx scripts/inspect-repeatables.ts --tenant=tarino    (filter)

import { Queue } from 'bullmq'
import { createRedisConnection } from '../src/lib/redis'
import { config } from '../src/config'
import { SCHEDULE_QUEUE_NAME } from '../src/scheduler/types'
import * as readline from 'node:readline/promises'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const tenantFilter = args.find((a) => a.startsWith('--tenant='))?.split('=')[1]

;(async () => {
  const connection = createRedisConnection({
    host:     config.REDIS_HOST,
    port:     config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    label:    'inspect-repeatables',
  })

  const queue = new Queue(SCHEDULE_QUEUE_NAME, { connection })
  const jobs = await queue.getRepeatableJobs()

  if (jobs.length === 0) {
    console.log('no repeatables registered. either the queue is empty or you')
    console.log('are connected to the wrong Redis (check REDIS_HOST in .env).')
    process.exit(0)
  }

  // Sort: by id, then by next fire time
  jobs.sort((a, b) => {
    if (a.id !== b.id) return (a.id ?? '').localeCompare(b.id ?? '')
    return (a.next ?? 0) - (b.next ?? 0)
  })

  // Group by id to make duplicates obvious
  const byId = new Map<string, typeof jobs>()
  for (const j of jobs) {
    const id = j.id ?? '(no-id)'
    if (tenantFilter && !id.includes(tenantFilter)) continue
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id)!.push(j)
  }

  console.log(`\nTotal repeatables: ${jobs.length}`)
  if (tenantFilter) console.log(`Filtered to: ${tenantFilter}\n`)
  console.log('─'.repeat(80))

  let dupeCount = 0
  for (const [id, list] of byId) {
    const isDupe = list.length > 1
    if (isDupe) dupeCount++
    const marker = isDupe ? '⚠️  DUPLICATE ID' : '  '
    console.log(`\n${marker} ${id}  (${list.length} entries)`)
    for (const j of list) {
      const next = j.next ? new Date(j.next).toISOString() : '(none)'
      console.log(`    cron=${j.pattern}  tz=${j.tz}  next=${next}`)
      console.log(`    key=${j.key.slice(0, 80)}...`)
    }
  }
  console.log('\n' + '─'.repeat(80))

  if (dupeCount > 0) {
    console.log(`\n⚠️  Found ${dupeCount} jobId(s) with duplicate entries — these are causing double-fires.`)
  } else {
    console.log('\n✓ No duplicate jobIds found.')
  }

  if (dryRun) {
    console.log('\ndry-run mode — nothing changed.')
    process.exit(0)
  }

  // Interactive removal
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log('\nReview each repeatable. Remove the stale ones (typically:')
  console.log('  - duplicates with old cron expressions')
  console.log('  - auto-generated IDs that don\'t match {tenant}__{runKind} pattern')
  console.log('  - jobIds for tenants/runKinds you no longer use')

  let removedCount = 0
  for (const j of jobs) {
    if (tenantFilter && !(j.id ?? '').includes(tenantFilter)) continue
    const next = j.next ? new Date(j.next).toISOString() : '(none)'
    console.log(`\n→ id=${j.id}  cron=${j.pattern}  tz=${j.tz}  next=${next}`)
    const ans = await rl.question('  remove? (y/n/q to quit): ')
    if (ans.trim().toLowerCase() === 'q') break
    if (ans.trim().toLowerCase() === 'y') {
      await queue.removeRepeatableByKey(j.key)
      console.log('  ✓ removed')
      removedCount++
    }
  }
  rl.close()

  console.log(`\nDone. Removed ${removedCount} repeatable(s).`)
  console.log('\nNext: restart Cloud Run so bootstrapSchedules re-registers the')
  console.log('current DB schedules from a clean state:')
  console.log('  gcloud run services update cgs-agent-shell --region us-central1 \\')
  console.log('    --update-env-vars=CACHE_BUST="$(date +%s)" \\')
  console.log('    --project=cgs-agent-shell-495221')
  process.exit(0)
})()
