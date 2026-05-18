// wire-bundle-3-4.js
//
// Bundle 3+4 of the next merge.
//
//   Bundle 3 — Slack 'secretchrontest' cron simulator. Mention @bot with
//     that phrase anywhere in the text → enqueues a one-off scheduled-run
//     job (runKind='seo_audit') to BullMQ. The existing scheduler worker
//     picks it up and runs runFullAuditCycle IDENTICALLY to a real cron
//     tick. No customer-facing Slack output (the cron path is silent —
//     customers experience the audit through the next daily run). One
//     operator-facing ack so you know the trigger landed.
//
//   Bundle 4 — Drop the Humanizer SKILL.md into ./skills/the-humanizer/
//     so the skill loader picks it up. Step 6 (file-self-update loop) is
//     rewritten to flag patterns for human review instead of editing the
//     skill file at runtime (prod container is read-only).
//
// Files touched:
//   - src/scheduler/index.ts          — adds enqueueOneOffRun export
//   - src/tenants/slackManager.ts     — adds import + handler block
//   - skills/the-humanizer/SKILL.md   — created
//
// Idempotent: re-running after success exits 0 without changing anything.
// Atomic: if any anchor is missing, NO files are modified.
//
// Usage (from repo root, with the-humanizer-source.md alongside this file):
//   node wire-bundle-3-4.js
//
// After running:
//   npx tsc --noEmit
//   (and test in Slack: @bot secretchrontest)

const fs = require('fs')
const path = require('path')

const repo = process.cwd()
const scriptDir = __dirname

// ── Bundle 3a: scheduler enqueueOneOffRun export ─────────────────────────

const schedulerPath = path.resolve(repo, 'src/scheduler/index.ts')

const schedulerAnchor = `  return _queue;
}

export async function bootstrapSchedules(): Promise<void> {`

const schedulerReplacement = `  return _queue;
}

/**
 * Enqueue a one-off scheduled-run job. Goes through exactly the same
 * worker code path as a real cron firing — used for ad-hoc testing of
 * runKinds (typically 'seo_audit') without waiting for the cron tick.
 * The worker's existing logs ('seo_audit_cycle_starting' /
 * 'seo_audit_cycle_completed') fire as usual.
 */
export async function enqueueOneOffRun(input: {
  tenantId: string
  runKind:  RunKind
}): Promise<void> {
  await queue().add(
    'scheduled-run',
    {
      tenantId:   input.tenantId,
      runKind:    input.runKind,
      triggerAt:  new Date().toISOString(),
      scheduleId: \`oneoff__\${input.tenantId}__\${input.runKind}__\${Date.now()}\`,
    },
  )
  logger.info('schedule_oneoff_enqueued', {
    tenantId: input.tenantId, runKind: input.runKind,
  })
}

export async function bootstrapSchedules(): Promise<void> {`

// ── Bundle 3b: slackManager.ts patches ───────────────────────────────────

const slackManagerPath = path.resolve(repo, 'src/tenants/slackManager.ts')

const slackImportAnchor = `import { handleThreadFeedback } from '../feedback/handler'`
const slackImportReplacement = `import { handleThreadFeedback } from '../feedback/handler'
import { enqueueOneOffRun } from '../scheduler'`

const slackHandlerAnchor = `    if (!prompt) {
      await say({
        text: \`Hi! Mention me with a task. Example:\\n\\\`@bot run an SEO audit on example.com\\\`\`,
        thread_ts: event.ts,
      })
      return
    }

    const task = await enqueueTask({`

const slackHandlerReplacement = `    if (!prompt) {
      await say({
        text: \`Hi! Mention me with a task. Example:\\n\\\`@bot run an SEO audit on example.com\\\`\`,
        thread_ts: event.ts,
      })
      return
    }

    // ── Secret operator command: cron simulator ─────────────────────────
    // Enqueues a one-off scheduled-run job for runKind='seo_audit'. The
    // scheduler worker picks it up and runs runFullAuditCycle identically
    // to a real cron tick (logs 'seo_audit_cycle_starting' /
    // 'seo_audit_cycle_completed'). No customer-facing Slack output — the
    // cron path is silent, and the customer experiences the audit through
    // the next daily run's Slack post. The single ack below is operator-
    // facing only so you know the trigger landed; check Cloud Run logs
    // and DB for actual progress.
    if (prompt.toLowerCase().includes('secretchrontest')) {
      logger.info('adhoc_audit_trigger_received', {
        tenantId: tenant.tenantId,
        userId:   event.user ?? 'unknown',
      })
      try {
        await enqueueOneOffRun({ tenantId: tenant.tenantId, runKind: 'seo_audit' })
        await say({
          text:      \`:eyes: Trigger received. Queued one-off \\\`seo_audit\\\` cycle for *\${tenant.clientName}* — identical code path to the Saturday-midnight cron. Watch Cloud Run logs for \\\`seo_audit_cycle_completed\\\`. No further Slack output from this command.\`,
          thread_ts: event.ts,
        })
      } catch (err) {
        await say({
          text:      \`:x: Failed to queue audit: \${String(err).slice(0, 200)}\`,
          thread_ts: event.ts,
        })
        logger.error('adhoc_audit_enqueue_failed', {
          tenantId: tenant.tenantId,
          err:      String(err).slice(0, 500),
        })
      }
      return
    }

    const task = await enqueueTask({`

// ── Bundle 4: Humanizer SKILL.md prepare ─────────────────────────────────

const humanizerSourcePath = path.resolve(scriptDir, 'the-humanizer-source.md')
const humanizerTargetDir  = path.resolve(repo, 'skills/the-humanizer')
const humanizerTargetPath = path.resolve(humanizerTargetDir, 'SKILL.md')

const originalStep6Marker = '## Auto-Improvement Loop (Run After Every Review)'

const newStep6 = `## Auto-Improvement Loop (Run After Every Review)

After completing every review and rewrite, run this step.

### Step 6: Flag New Patterns for Human Review

Compare the flags you raised in this review against the detection lists already in this skill file. For each flag, check:

1. **Is this pattern already documented in the skill?** If yes, skip it.
2. **Is this a new pattern worth catching in future reviews?** If yes, surface it as a suggestion for human review. Do NOT attempt to edit the skill file — the production container is read-only, and a human merges accepted patterns manually into the source.

### Categorisation for flagged patterns:

- New universal phrase-level patterns → "Universal Phrase-Level Markers"
- New universal structural patterns → "Universal Structural Markers"
- New channel-specific patterns → the relevant channel section (LinkedIn, Email, Slack)
- New originality concerns → Step 2

### How to flag a new pattern:

- Write it as a specific, flaggable rule with a concrete example from the content you just reviewed
- Note the section it would go into
- Do not duplicate existing rules
- Do not flag vague patterns. If you can't give a concrete example, skip it.

### Output to the user after the review/rewrite:

\`\`\`
## Skill Update (For Human Review)
- [X] new pattern(s) flagged:
  - "<pattern name>" — example: "<concrete quote from the content>" — would go in <section>
- [ ] no new patterns found this review
\`\`\`

If no new patterns were found, check the box for "no new patterns" instead. The operator periodically reviews flagged patterns and merges accepted ones into the source skill file.
`

// ── Pre-flight ───────────────────────────────────────────────────────────

if (!fs.existsSync(schedulerPath)) {
  console.error('ERROR: scheduler/index.ts not found at', schedulerPath)
  process.exit(1)
}
if (!fs.existsSync(slackManagerPath)) {
  console.error('ERROR: slackManager.ts not found at', slackManagerPath)
  process.exit(1)
}
if (!fs.existsSync(humanizerSourcePath)) {
  console.error('ERROR: the-humanizer-source.md not found next to this wire script.')
  console.error('Expected at:', humanizerSourcePath)
  console.error('Make sure both wire-bundle-3-4.js AND the-humanizer-source.md are next to each other.')
  process.exit(1)
}

const schedulerSrcOriginal = fs.readFileSync(schedulerPath, 'utf8')
const slackSrcOriginal     = fs.readFileSync(slackManagerPath, 'utf8')
const humanizerSrcOriginal = fs.readFileSync(humanizerSourcePath, 'utf8')

const schedulerAlreadyPatched = schedulerSrcOriginal.includes('export async function enqueueOneOffRun')
const slackAlreadyPatched     = slackSrcOriginal.includes('secretchrontest')
const humanizerAlreadyExists  = fs.existsSync(humanizerTargetPath)

if (!schedulerAlreadyPatched) {
  if (!schedulerSrcOriginal.includes(schedulerAnchor)) {
    console.error('ERROR: anchor not found in scheduler/index.ts.')
    console.error('Expected the area between queue() and bootstrapSchedules().')
    process.exit(1)
  }
}

if (!slackAlreadyPatched) {
  if (!slackSrcOriginal.includes(slackImportAnchor)) {
    console.error('ERROR: import anchor not found in slackManager.ts.')
    console.error("Expected: import { handleThreadFeedback } from '../feedback/handler'")
    process.exit(1)
  }
  if (!slackSrcOriginal.includes(slackHandlerAnchor)) {
    console.error('ERROR: app_mention handler anchor not found in slackManager.ts.')
    process.exit(1)
  }
}

if (!humanizerAlreadyExists) {
  if (!humanizerSrcOriginal.includes(originalStep6Marker)) {
    console.error('ERROR: Step 6 marker not found in the-humanizer-source.md.')
    console.error('Expected:', originalStep6Marker)
    process.exit(1)
  }
}

if (schedulerAlreadyPatched && slackAlreadyPatched && humanizerAlreadyExists) {
  console.log('• scheduler enqueueOneOffRun: already exported, skipping')
  console.log('• slack secret trigger: already patched, skipping')
  console.log('• humanizer SKILL.md: already exists, skipping')
  console.log('')
  console.log('✓ All patches already applied. No changes made.')
  process.exit(0)
}

// ── Apply ────────────────────────────────────────────────────────────────

if (schedulerAlreadyPatched) {
  console.log('• scheduler enqueueOneOffRun: already exported, skipping')
} else {
  const patched = schedulerSrcOriginal.replace(schedulerAnchor, schedulerReplacement)
  fs.writeFileSync(schedulerPath, patched)
  console.log('✓ Patched src/scheduler/index.ts (added enqueueOneOffRun export)')
}

if (slackAlreadyPatched) {
  console.log('• slack secret trigger: already patched, skipping')
} else {
  let slackSrc = slackSrcOriginal
  slackSrc = slackSrc.replace(slackImportAnchor, slackImportReplacement)
  slackSrc = slackSrc.replace(slackHandlerAnchor, slackHandlerReplacement)
  fs.writeFileSync(slackManagerPath, slackSrc)
  console.log('✓ Patched src/tenants/slackManager.ts')
}

if (humanizerAlreadyExists) {
  console.log('• humanizer SKILL.md: already exists, skipping')
} else {
  const markerIdx = humanizerSrcOriginal.indexOf(originalStep6Marker)
  const finalContent = humanizerSrcOriginal.slice(0, markerIdx) + newStep6
  fs.mkdirSync(humanizerTargetDir, { recursive: true })
  fs.writeFileSync(humanizerTargetPath, finalContent)
  console.log('✓ Created skills/the-humanizer/SKILL.md')
}

console.log('')
console.log('Bundle 3+4 applied. Next steps:')
console.log('  1. npx tsc --noEmit                       # verify type-check passes')
console.log('  2. git status                             # confirm changed files')
console.log('  3. git diff src/scheduler/ src/tenants/   # eyeball the changes')
console.log('  4. After deploy: @bot secretchrontest in Tarino Slack,')
console.log('     then watch Cloud Run logs for seo_audit_cycle_completed')
