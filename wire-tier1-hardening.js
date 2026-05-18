const fs = require('fs')
const path = require('path')

const patches = [
  // ─────────────────────────────────────────────────────────────────────
  // 1. Aggregator: inject approval_requests rows into user prompt as
  //    authoritative ground truth for awaitingApproval titles/details.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/orchestrator/aggregator.ts',
    label: 'aggregator: inject approval_requests block + tighten title rules',
    sentinel: 'loadPendingApprovalsForPrompt',
    edits: [
      // Add the loader helper just before buildAggregatorUserPrompt
      {
        old: `// ── User prompt builder ───────────────────────────────────────────────────

function buildAggregatorUserPrompt(
  task: AgentTask,
  outputs: Array<{ specialistType: string; specialistName: string; summary: string; fullOutput: string }>,
  trigger: TaskTrigger,
  differentialBlock = '',
): string {`,
        new: `// ── User prompt builder ───────────────────────────────────────────────────

/**
 * Load pending approval_requests for this task and format as a structured
 * block for the aggregator's synthesis LLM. This is the AUTHORITATIVE
 * source for awaitingApproval titles + details — without it, the LLM
 * extrapolates from specialist narrative and produces generic placeholders
 * like "On-page improvement #1 — quick copy or meta tweak".
 */
async function loadPendingApprovalsForPrompt(taskId: string): Promise<string> {
  const { rows } = await bankPool.query<{
    id: string
    tool_name: string
    tool_input: any
    risk_reason: string | null
    requested_at: Date
  }>(
    \`SELECT id, tool_name, tool_input, risk_reason, requested_at
       FROM approval_requests
      WHERE task_id = $1 AND status = 'pending'
      ORDER BY requested_at ASC\`,
    [taskId]
  )
  if (rows.length === 0) return ''

  const formatted = rows.map(r => {
    const inputStr = JSON.stringify(r.tool_input ?? {}).slice(0, 1200)
    const reason   = String(r.risk_reason ?? '').slice(0, 400)
    return \`- id: \${r.id}
  tool_name: \${r.tool_name}
  requested_at: \${r.requested_at.toISOString()}
  tool_input: \${inputStr}
  risk_reason: \${reason}\`
  }).join('\\n\\n')

  return \`# Pending approvals for this run (AUTHORITATIVE — use as ground truth for awaitingApproval)

These are the EXACT rows in approval_requests with status='pending' for this task. Use them DIRECTLY to populate the awaitingApproval array in your output. Rules:

- Copy the \\\`id\\\` value verbatim into the output's id field.
- Use \\\`requested_at\\\` (ISO datetime) as pendingSince.
- For \\\`title\\\`: pull the first sentence (up to ~180 chars) from \\\`tool_input.instruction\\\` (for manual_operator_task) or \\\`tool_input.post_title\\\` (for blog post tools), or build a specific title from the most informative field. NEVER use placeholder phrases like "On-page improvement #N", "quick copy or meta tweak", "exact instruction is in the approval card", "specific fix", or any generic template.
- For \\\`detail\\\`: use the remainder of tool_input.instruction, or risk_reason. Up to ~350 chars. Must be specific and actionable.
- Severity: critical for security/breakage, high for publishing/outreach, medium for fixes, low for housekeeping.

\${formatted}
\`
}

function buildAggregatorUserPrompt(
  task: AgentTask,
  outputs: Array<{ specialistType: string; specialistName: string; summary: string; fullOutput: string }>,
  trigger: TaskTrigger,
  differentialBlock = '',
  pendingApprovalsBlock = '',
): string {`,
      },
      // Inject the block into the user prompt string
      {
        old: `  const diffSection = differentialBlock ? \`\\n\${differentialBlock}\\n\\n---\\n\` : ''

  return \`\${triggerContext}

Original task: \${task.prompt}
\${diffSection}
The following specialist agents have completed their work. Synthesise their findings into the structured JSON shape defined in your system prompt.`,
        new: `  const diffSection      = differentialBlock      ? \`\\n\${differentialBlock}\\n\\n---\\n\`      : ''
  const approvalsSection = pendingApprovalsBlock   ? \`\\n\${pendingApprovalsBlock}\\n\\n---\\n\` : ''

  return \`\${triggerContext}

Original task: \${task.prompt}
\${diffSection}\${approvalsSection}
The following specialist agents have completed their work. Synthesise their findings into the structured JSON shape defined in your system prompt.`,
      },
      // Wire the load + pass at the call site
      {
        old: `    // Single Claude call to synthesise — system prompt picked by trigger.
    const systemPrompt = getAggregatorSystemPromptFor(trigger, tenant)
    const userPrompt = buildAggregatorUserPrompt(task, outputs, trigger, differentialBlock)`,
        new: `    // Single Claude call to synthesise — system prompt picked by trigger.
    const systemPrompt = getAggregatorSystemPromptFor(trigger, tenant)
    const pendingApprovalsBlock = await loadPendingApprovalsForPrompt(task.id)
    const userPrompt = buildAggregatorUserPrompt(task, outputs, trigger, differentialBlock, pendingApprovalsBlock)`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 2. Outreach guard: return null from buildOutreachSpec when target is
  //    unknown. Caller already handles null (skips the card).
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/core/opportunity-bank/card-builder.ts',
    label: 'outreach: reject (unknown) target cards',
    sentinel: 'outreach_guard_skip',
    edits: [
      {
        old: `function buildOutreachSpec(input: OutreachSpecInput): CardSpec {
  const d = input.detail
  const sourceUrl  = str(d.source_url) ?? '(unknown)'
  const sourceDom  = str(d.source_domain) ?? str(d.source_url) ?? '(unknown)'`,
        new: `function buildOutreachSpec(input: OutreachSpecInput): CardSpec | null {
  const d = input.detail
  const sourceUrl  = str(d.source_url) ?? '(unknown)'
  const sourceDom  = str(d.source_domain) ?? str(d.source_url) ?? '(unknown)'

  // Guard: don't file approval cards with no real target — they're
  // unactionable noise for the operator. If DataForSEO/research failed
  // upstream, fail the surfacing here rather than ship a broken card.
  if (sourceDom === '(unknown)' || !sourceDom || sourceUrl === '(unknown)' || !sourceUrl) {
    logger.warn('outreach_guard_skip', {
      opportunityId: input.opp.id,
      prospectKind:  input.prospectKind,
      reason:        'target_site or source_url is (unknown) — refusing to file noise card',
    })
    return null
  }
`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 3. NaNd fix — coerce pendingSince in the reduce that finds the oldest
  //    pending approval. String < Date silently breaks.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/core/slack/blocks/daily-run.ts',
    label: 'daily-run: coerce pendingSince in awaiting-summary reduce',
    sentinel: 'pendingSince instanceof Date',
    edits: [
      {
        old: `function awaitingSummaryLine(items: ApprovalItem[]): string {
  const oldest = items.reduce(
    (max, i) => (i.pendingSince < max ? i.pendingSince : max),
    new Date()
  );
  return \`\${items.length} blocked · oldest pending \${formatRelative(oldest)}\`;
}`,
        new: `function awaitingSummaryLine(items: ApprovalItem[]): string {
  const oldest = items.reduce(
    (min: Date, i) => {
      // Coerce — pendingSince may arrive as a JSON string, not a Date
      const d = i.pendingSince instanceof Date ? i.pendingSince : new Date(i.pendingSince as any)
      return Number.isNaN(d.getTime()) ? min : (d < min ? d : min)
    },
    new Date()
  );
  return \`\${items.length} blocked · oldest pending \${formatRelative(oldest)}\`;
}`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 4. formatRelative robustness — return "recently" instead of "NaNd ago"
  //    when given an invalid date.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/core/slack/blocks/shared.ts',
    label: 'shared: formatRelative handles invalid Date gracefully',
    sentinel: 'isNaN(d.getTime())',
    edits: [
      {
        old: `export function formatRelative(d: Date | string, now: Date = new Date()): string {
  d = toDate(d)
  const diffMs = now.getTime() - d.getTime();`,
        new: `export function formatRelative(d: Date | string, now: Date = new Date()): string {
  d = toDate(d)
  if (Number.isNaN(d.getTime())) return 'recently'
  const diffMs = now.getTime() - d.getTime();`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 5. Subagent final-failure → Slack update. Hook the worker.on('failed')
  //    event which fires when retries are exhausted, and call
  //    presenter.failRun on subagent final failures.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/queue/worker.ts',
    label: 'worker: presenter.failRun on subagent final-attempt failure',
    sentinel: 'subagent_final_failure_slack_update',
    edits: [
      {
        old: `worker.on('completed', job => logger.info('job_done', { jobId: job.id, type: job.data.jobType }))
worker.on('failed', (job, err) => logger.error('job_err', { jobId: job?.id, type: job?.data?.jobType, err: err.message }))`,
        new: `worker.on('completed', job => logger.info('job_done', { jobId: job.id, type: job.data.jobType }))
worker.on('failed', async (job, err) => {
  logger.error('job_err', { jobId: job?.id, type: job?.data?.jobType, err: err.message })

  // subagent_final_failure_slack_update:
  // When a subagent job is permanently failed (retries exhausted), close
  // the loop on Slack — otherwise the anchor stays stuck in "Planning" or
  // "Executing" forever. Only fire on FINAL attempt — earlier retries may
  // still succeed.
  try {
    if (!job) return
    const isFinalAttempt = job.attemptsMade >= (job.opts?.attempts ?? 1)
    if (!isFinalAttempt) return
    if (job.data?.jobType !== 'subagent') return
    const taskId = job.data.task?.id
    if (!taskId) return
    await presenter.failRun(taskId, \`Subagent failed (\${job.attemptsMade} attempts): \${String(err?.message ?? err).slice(0, 300)}\`)
    logger.info('subagent_final_failure_slack_updated', { taskId, attempts: job.attemptsMade })
  } catch (e) {
    logger.error('subagent_final_failure_slack_error', { err: String(e).slice(0, 300) })
  }
})`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 6. Framer connect() timeout — every first-attempt hang we've seen
  //    correlates with framer_session_open. The connect() call has no
  //    timeout. Same pattern as the web_fetch/web_search fixes.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/integrations/framer/client.ts',
    label: 'framer: timeout on connect()',
    sentinel: 'framer_connect_timeout',
    edits: [
      {
        old: `  const connect = await getConnect()
  const client = await connect(projectUrl, cred.secret)
  logger.info('framer_session_open', { tenantId: tenant.tenantId, projectUrl })`,
        new: `  const connect = await getConnect()
  const client = await Promise.race([
    connect(projectUrl, cred.secret),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('framer_connect_timeout after 20s')),
      20_000
    )),
  ]).catch(err => {
    logger.error('framer_connect_timeout', { tenantId: tenant.tenantId, projectUrl, err: String(err).slice(0, 200) })
    throw err
  })
  logger.info('framer_session_open', { tenantId: tenant.tenantId, projectUrl })`,
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

if (allDone) console.log('all 6 patches already applied')
else console.log('done')
