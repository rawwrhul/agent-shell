const fs = require('fs')
const path = require('path')

const patches = [
  {
    file: 'src/orchestrator/aggregator.ts',
    label: 'aggregator: timeout on LLM call + presenter.failRun timeout',
    sentinel: 'timeout: 180_000',
    edits: [
      {
        old: `    const response = await anthropic.messages.create({
      model:      tenant.agentModel,
      max_tokens: 8096,
      // Cache the system prompt — it's deterministic per (trigger, tenant)
      // pair, so daily/weekly cron runs hit the cache reliably. Specialist
      // outputs (in messages) vary per run and stay uncached.
      system:     cachedSystem(systemPrompt),
      messages:   [{ role: 'user', content: userPrompt }],
    })`,
        new: `    const response = await anthropic.messages.create({
      model:      tenant.agentModel,
      max_tokens: 8096,
      // Cache the system prompt — it's deterministic per (trigger, tenant)
      // pair, so daily/weekly cron runs hit the cache reliably. Specialist
      // outputs (in messages) vary per run and stay uncached.
      system:     cachedSystem(systemPrompt),
      messages:   [{ role: 'user', content: userPrompt }],
    }, {
      // Explicit 3-min timeout. Default SDK timeout is 10min which is
      // longer than BullMQ's default 30s lockDuration — caused silent
      // hangs + retry cascades. 180s fits comfortably under the new
      // 5-min lockDuration set in src/queue/worker.ts.
      timeout: 180_000,
    })`,
      },
      {
        old: `  } catch (err) {
    logger.error('aggregator_failed', { taskId: task.id, err: String(err) })
    await presenter.failRun(task.id, String(err).slice(0, 400))
    await endTrace(sessionId, 'error')
    throw err
  }
}`,
        new: `  } catch (err) {
    logger.error('aggregator_failed', { taskId: task.id, err: String(err).slice(0, 500) })
    // Wrap failRun + endTrace in their own timeouts so a hung Slack/
    // Langfuse call can't trap us in the failure path indefinitely.
    await Promise.race([
      presenter.failRun(task.id, String(err).slice(0, 400)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('failrun_timeout')), 30_000)),
    ]).catch((failErr) => logger.warn('aggregator_failrun_failed', { taskId: task.id, err: String(failErr).slice(0, 200) }))
    await Promise.race([
      endTrace(sessionId, 'error'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('endtrace_timeout')), 10_000)),
    ]).catch(() => { /* swallow — already in failure path */ })
    throw err
  }
}`,
      },
    ],
  },

  {
    file: 'src/queue/worker.ts',
    label: 'worker: lockDuration 5min + maxStalledCount 0',
    sentinel: 'lockDuration:     300_000',
    edits: [
      {
        old: `  {
    connection,
    concurrency: 8,  // Enough to run multiple subagents in parallel across tenants
    limiter: { max: 20, duration: 60_000 },
  }
)`,
        new: `  {
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
)`,
      },
    ],
  },

  {
    file: 'src/queue/producer.ts',
    label: 'producer: aggregate jobs get attempts:1',
    sentinel: 'attempts: 1',
    edits: [
      {
        old: `export async function enqueueAggregationJob(task: AgentTask) {
  await agentQueue.add('aggregate',
    { jobType: 'aggregate', task } as AgentJob,
    { jobId: \`aggregate-\${task.id}\`, priority: 1 })
  logger.info('aggregation_enqueued', { taskId: task.id })
}`,
        new: `export async function enqueueAggregationJob(task: AgentTask) {
  await agentQueue.add('aggregate',
    { jobType: 'aggregate', task } as AgentJob,
    {
      jobId:    \`aggregate-\${task.id}\`,
      priority: 1,
      // Aggregate is non-idempotent (posts to Slack, creates approval
      // cards). Don't retry on failure — the timeout + failRun path
      // updates Slack to show the failure state.
      attempts: 1,
    })
  logger.info('aggregation_enqueued', { taskId: task.id })
}`,
      },
    ],
  },

  {
    file: 'src/core/opportunity-bank/types.ts',
    label: 'bank: surface limit 7 → 5',
    sentinel: 'DEFAULT_SURFACE_LIMIT = 5',
    edits: [
      {
        old: `/** Default size of the daily run's surface batch. */
export const DEFAULT_SURFACE_LIMIT = 7`,
        new: `/** Default size of the daily run's surface batch. Reduced from 7 to 5
 *  to keep the aggregator's LLM synthesis input bounded — 7 verbose
 *  approval-card riskReasons + specialist propose_actions was pushing
 *  context size enough to cause slow LLM responses + stall risk. */
export const DEFAULT_SURFACE_LIMIT = 5`,
      },
    ],
  },
]

let allDone = true
for (const p of patches) {
  const abs = path.resolve(process.cwd(), p.file)
  if (!fs.existsSync(abs)) { console.error('NOT FOUND:', p.file); process.exit(1) }
  const src = fs.readFileSync(abs, 'utf8')
  if (src.includes(p.sentinel)) {
    console.log('• ' + p.label + ': already patched')
    continue
  }
  allDone = false
  let next = src
  for (const e of p.edits) {
    if (!next.includes(e.old)) {
      console.error('ANCHOR NOT FOUND in ' + p.file)
      console.error('  Expected (first 200 chars):')
      console.error('  ' + e.old.slice(0, 200).replace(/\n/g, '\n  '))
      process.exit(1)
    }
    next = next.replace(e.old, e.new)
  }
  fs.writeFileSync(abs, next)
  console.log('✓ Patched ' + p.file)
}

if (allDone) console.log('all 4 patches were already applied')
else console.log('done')
