const fs = require('fs')
const path = require('path')

const patches = [
  // ====================================================================
  // 1. web_fetch body-read timeout + graceful error returns
  // ====================================================================
  {
    file: 'src/agents/tools.ts',
    label: 'webFetch: total-budget timeout + graceful error returns',
    sentinel: 'web_fetch body timeout',
    edits: [
      {
        old: `async function webFetch(url: string): Promise<string> {
  const res  = await fetch(url, { headers: { 'User-Agent': 'CGS-Agent/2.0' }, signal: AbortSignal.timeout(15000) })
  const text = await res.text()
  // Strip HTML tags for cleaner context
  const clean = text.replace(/<script[\\s\\S]*?<\\/script>/gi, '')
                    .replace(/<style[\\s\\S]*?<\\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\\s{2,}/g, ' ')
                    .trim()
  return clean.length > 40000 ? clean.slice(0, 40000) + '\\n[Truncated]' : clean
}`,
        new: `async function webFetch(url: string): Promise<string> {
  // Two-layer timeout. AbortSignal in fetch() covers the network handshake,
  // but in some Node versions it doesn't reliably propagate into res.text()
  // for chunked-encoding/keep-alive responses that never close. The outer
  // Promise.race is the belt-and-braces guard.
  const controller    = new AbortController()
  const networkTimer  = setTimeout(() => controller.abort(), 15_000)

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'CGS-Agent/2.0' },
      signal:  controller.signal,
    })
  } catch (err: any) {
    clearTimeout(networkTimer)
    return \`[web_fetch network error for \${url}: \${String(err?.message ?? err).slice(0, 200)}]\`
  }

  if (!res.ok) {
    clearTimeout(networkTimer)
    return \`[web_fetch HTTP \${res.status} for \${url}]\`
  }

  let text: string
  try {
    text = await Promise.race([
      res.text(),
      new Promise<string>((_, reject) => setTimeout(() => {
        controller.abort()
        reject(new Error('body_read_timeout'))
      }, 30_000)),
    ])
  } catch {
    clearTimeout(networkTimer)
    return \`[web_fetch body timeout after 30s for \${url}]\`
  }
  clearTimeout(networkTimer)

  // Strip HTML tags for cleaner context
  const clean = text.replace(/<script[\\s\\S]*?<\\/script>/gi, '')
                    .replace(/<style[\\s\\S]*?<\\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\\s{2,}/g, ' ')
                    .trim()
  return clean.length > 40000 ? clean.slice(0, 40000) + '\\n[Truncated]' : clean
}`,
      },
    ],
  },

  // ====================================================================
  // 2. preToolUseHook: log target on tool_call for diagnostics
  // ====================================================================
  {
    file: 'src/hooks/index.ts',
    label: 'preToolUseHook: log target URL/path on tool_call',
    sentinel: 'target:      summariseToolInput',
    edits: [
      {
        old: `  logger.info('tool_call', {
    tenantId:    ctx.tenant.tenantId,
    taskId:      ctx.taskId,
    tool:        event.toolName,
    risk:        risk.level,
    autoApprove: risk.autoApprove,
  })`,
        new: `  logger.info('tool_call', {
    tenantId:    ctx.tenant.tenantId,
    taskId:      ctx.taskId,
    tool:        event.toolName,
    risk:        risk.level,
    autoApprove: risk.autoApprove,
    // Short target string for diagnostics — URL for web_fetch, path for
    // file ops, first chars of cmd for run_command. Without this a
    // tool-call hang is invisible in logs.
    target:      summariseToolInput(event.toolName, event.input),
  })`,
      },
      {
        old: `export async function preToolUseHook(`,
        new: `function summariseToolInput(tool: string, input: any): string {
  try {
    if (!input || typeof input !== 'object') return ''
    if (tool === 'web_fetch' || tool === 'web_search') return String(input.url ?? input.query ?? '').slice(0, 200)
    if (tool === 'read_file' || tool === 'write_file' || tool === 'list_directory') return String(input.path ?? '').slice(0, 200)
    if (tool === 'run_command') return String(input.command ?? '').slice(0, 200)
    if (tool === 'propose_action') return String(input.action_type ?? input.opportunity_type ?? '').slice(0, 80)
    for (const v of Object.values(input)) {
      if (typeof v === 'string') return v.slice(0, 200)
    }
    return ''
  } catch { return '' }
}

export async function preToolUseHook(`,
      },
    ],
  },

  // ====================================================================
  // 3. Worker-level watchdog per job type
  // ====================================================================
  {
    file: 'src/queue/worker.ts',
    label: 'worker: per-job-type watchdog timeouts',
    sentinel: 'withJobWatchdog',
    edits: [
      {
        old: `        case 'orchestrate':
          await runOrchestrator(task, tenant)
          break

        case 'subagent':
          if (!subTaskId) throw new Error('subTaskId missing on subagent job')
          await runSubagent(task, subTaskId, tenant)
          break

        case 'aggregate':
          await runAggregator(task, tenant)
          break`,
        new: `        case 'orchestrate':
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
          break`,
      },
      {
        // Add the helper at module scope, after the Worker construction
        old: `worker.on('completed', job => logger.info('job_done', { jobId: job.id, type: job.data.jobType }))`,
        new: `/**
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
          reject(new Error(\`watchdog_timeout_\${label}_after_\${ms}ms\`))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

worker.on('completed', job => logger.info('job_done', { jobId: job.id, type: job.data.jobType }))`,
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

if (allDone) console.log('all 3 patches were already applied')
else console.log('done')
