// wire-opportunity-bank.js
//
// Foundation bundle: opportunity bank + state machine + selection algorithm
// + daily-run bank consumption + Slack ad-hoc bank check + HITL reshape-on-reject.
//
// This is the biggest bundle since SEO-2. It does TWO things:
//
//   1. Drops new files into the repo:
//        - db/migrations/opportunity-bank.ts
//        - src/core/opportunity-bank/{types,select,transitions,reshape,ad-hoc-match,index}.ts
//        - scripts/smoke-opportunity-bank.ts
//
//   2. Applies four surgical patches to existing files:
//        - db/migrate.ts                    — register the new migration
//        - src/orchestrator/aggregator.ts   — call pickForDailyRun in cron-daily branch
//        - src/tenants/slackManager.ts      — ad-hoc bank check before enqueueTask
//        - src/hitl/handlers.ts             — hook handleRejectionOnOpportunity on reject
//
// Pre-flight: all anchors checked before any writes. All file copies and
// patches happen atomically (or not at all).
//
// Idempotent: re-runs cleanly. Skip-already-applied semantics for each piece.
//
// Usage (from repo root, with bundle's `files/` directory alongside this script):
//   node wire-opportunity-bank.js
//
// After running:
//   npx tsc --noEmit
//   npm run smoke:opportunity-bank   (after adding the smoke entry to package.json)
//   npm run db:migrate

const fs   = require('fs')
const path = require('path')

const repo      = process.cwd()
const scriptDir = __dirname
const filesDir  = path.resolve(scriptDir, 'files')

// ── New file drops ──────────────────────────────────────────────────────

const FILE_DROPS = [
  'db/migrations/opportunity-bank.ts',
  'src/core/opportunity-bank/types.ts',
  'src/core/opportunity-bank/select.ts',
  'src/core/opportunity-bank/transitions.ts',
  'src/core/opportunity-bank/reshape.ts',
  'src/core/opportunity-bank/ad-hoc-match.ts',
  'src/core/opportunity-bank/index.ts',
  'scripts/smoke-opportunity-bank.ts',
]

// ── Patches ─────────────────────────────────────────────────────────────

const PATCHES = [
  {
    file:     'db/migrate.ts',
    label:    'db/migrate: register opportunity-bank migration',
    sentinel: `runOpportunityBankMigration`,
    edits: [
      {
        anchor: `import { runSeo2AuditorMigration } from './migrations/seo-2-auditor'`,
        replacement: `import { runSeo2AuditorMigration } from './migrations/seo-2-auditor'
import { runOpportunityBankMigration } from './migrations/opportunity-bank'`,
      },
      {
        anchor: `  await runSeo2AuditorMigration(pool)`,
        replacement: `  await runSeo2AuditorMigration(pool)
  await runOpportunityBankMigration(pool)`,
      },
    ],
  },

  {
    file:     'src/orchestrator/aggregator.ts',
    label:    'aggregator: surface banked opportunities on cron-daily',
    sentinel: `pickForDailyRun`,
    edits: [
      {
        anchor: `import {
  loadDailyDifferential, loadWeeklyDifferential,
  formatDailyDifferentialForPrompt, formatWeeklyDifferentialForPrompt,
} from './cron-context'`,
        replacement: `import {
  loadDailyDifferential, loadWeeklyDifferential,
  formatDailyDifferentialForPrompt, formatWeeklyDifferentialForPrompt,
} from './cron-context'
import { pickForDailyRun } from '../core/opportunity-bank'`,
      },
      {
        anchor: `    if (trigger === 'cron-daily') {
      const diff = await loadDailyDifferential(task.tenantId)
      differentialBlock = formatDailyDifferentialForPrompt(diff)`,
        replacement: `    if (trigger === 'cron-daily') {
      const diff = await loadDailyDifferential(task.tenantId)
      differentialBlock = formatDailyDifferentialForPrompt(diff)

      // ── Bank consumption ────────────────────────────────────────────
      // Pick a diverse batch from the opportunity bank and atomically
      // transition them new → surfaced. The LLM is told about them
      // below so it includes them in 'newOpportunities' of its output.
      // Best-effort: any failure falls back to inline-only behaviour.
      try {
        const surfaced = await pickForDailyRun({
          tenantId: task.tenantId,
          runId:    task.id,
        })
        if (surfaced.length > 0) {
          differentialBlock += '\\n\\n## Opportunities surfaced from the bank this run\\n\\n'
            + 'These were filed by background runs (audit, future discovery skills) and have just been promoted from the bank into this customer-facing batch. They are now status=surfaced with surfaced_in_run_id stamped to this task. **Include each of them in the \`newOpportunities\` array of your structured output**, alongside any new ones the specialist discovered inline.\\n\\n'
            + surfaced.map((o) =>
                \`- [\${o.priority}] \${o.type} (id: \${o.id}): \${o.description}\${o.target ? ' — ' + o.target : ''}\`
              ).join('\\n')
          logger.info('aggregator_surfaced_from_bank', {
            taskId: task.id, tenantId: task.tenantId, count: surfaced.length,
          })
        }
      } catch (err) {
        logger.warn('aggregator_bank_surface_failed', {
          taskId: task.id, err: String(err).slice(0, 300),
        })
      }`,
      },
    ],
  },

  {
    file:     'src/tenants/slackManager.ts',
    label:    'slackManager: ad-hoc bank check before fresh discovery',
    sentinel: `matchAdHocRequest`,
    edits: [
      {
        anchor: `import { enqueueOneOffRun } from '../scheduler'`,
        replacement: `import { enqueueOneOffRun } from '../scheduler'
import { matchAdHocRequest, pickForAdHoc } from '../core/opportunity-bank'`,
      },
      {
        anchor: `        logger.error('adhoc_audit_enqueue_failed', {
          tenantId: tenant.tenantId,
          err:      String(err).slice(0, 500),
        })
      }
      return
    }

    const task = await enqueueTask({`,
        replacement: `        logger.error('adhoc_audit_enqueue_failed', {
          tenantId: tenant.tenantId,
          err:      String(err).slice(0, 500),
        })
      }
      return
    }

    // ── Ad-hoc bank check ───────────────────────────────────────────────
    // If the prompt is asking about an opportunity type we track and the
    // bank has enough matching rows, serve from the bank without spinning
    // up a fresh discovery run. Otherwise fall through to the normal
    // enqueueTask flow.
    try {
      const matched = await matchAdHocRequest({ prompt })
      if (matched && matched.types.length > 0) {
        const banked = await pickForAdHoc({
          tenantId: tenant.tenantId,
          types:    matched.types,
          limit:    5,
        })
        if (banked.length >= 3) {
          logger.info('adhoc_served_from_bank', {
            tenantId: tenant.tenantId,
            types:    matched.types,
            count:    banked.length,
          })
          const lines = banked.map((o, i) =>
            \`\${i + 1}. [\${o.priority}] \${o.type}\${o.target ? ' — ' + o.target : ''}\\n   \${o.description}\`
          ).join('\\n\\n')
          await say({
            text: \`Pulled \${banked.length} matching opportunities from the bank (no fresh discovery needed):\\n\\n\${lines}\\n\\n_If you want a fresh search anyway, rephrase with explicit \\\`run a discovery\\\` wording._\`,
            thread_ts: event.ts,
          })
          return
        }
        // Bank too thin — fall through to fresh discovery below.
        logger.info('adhoc_bank_too_thin_falling_through', {
          tenantId: tenant.tenantId,
          types:    matched.types,
          banked:   banked.length,
        })
      }
    } catch (err) {
      // Classifier or bank query failed — fall through to normal flow.
      logger.warn('adhoc_bank_check_failed', {
        tenantId: tenant.tenantId,
        err:      String(err).slice(0, 300),
      })
    }

    const task = await enqueueTask({`,
      },
    ],
  },

  {
    file:     'src/hitl/handlers.ts',
    label:    'hitl/handlers: hook reshape-on-reject',
    sentinel: `handleRejectionOnOpportunity`,
    edits: [
      {
        anchor: `import { onApprovalResolved } from '../memory/pipeline-events';`,
        replacement: `import { onApprovalResolved } from '../memory/pipeline-events';
import { handleRejectionOnOpportunity } from '../core/opportunity-bank';`,
      },
      {
        anchor: `  void onApprovalResolved({
    approvalId:      ctx.approvalId,
    tenantId:        approval.tenantId,
    toolName:        approval.toolName,
    proposedAction:  approval.proposedAction,
    toolInput:       approval.toolInput,
    status:          'rejected',
    resolvedBy:      ctx.slackUserId,
    rejectionReason: rejectionReason,
  })
}`,
        replacement: `  void onApprovalResolved({
    approvalId:      ctx.approvalId,
    tenantId:        approval.tenantId,
    toolName:        approval.toolName,
    proposedAction:  approval.proposedAction,
    toolInput:       approval.toolInput,
    status:          'rejected',
    resolvedBy:      ctx.slackUserId,
    rejectionReason: rejectionReason,
  })

  // Opportunity bank: if this approval was bank-linked, decide whether
  // to reshape (substantive feedback → new variant) or terminally reject
  // (flat rejection → kill). Best-effort; never blocks the HITL flow.
  void handleRejectionOnOpportunity({
    approvalId:      ctx.approvalId,
    rejectionReason: rejectionReason,
  })
}`,
      },
    ],
  },
]

// ── Pre-flight ───────────────────────────────────────────────────────────

if (!fs.existsSync(filesDir)) {
  console.error('ERROR: bundle files/ directory not found at', filesDir)
  console.error('Make sure both wire-opportunity-bank.js AND the files/ directory are next to each other.')
  process.exit(1)
}

// Pre-flight: every file drop's source must exist; target dir must exist
// or be creatable.
for (const rel of FILE_DROPS) {
  const src = path.join(filesDir, rel)
  if (!fs.existsSync(src)) {
    console.error('ERROR: bundle source file missing:', src)
    process.exit(1)
  }
}

// Pre-flight: every patch target must exist and either (a) be already
// patched or (b) have all anchors present.
const patchStates = []
for (const p of PATCHES) {
  const abs = path.resolve(repo, p.file)
  if (!fs.existsSync(abs)) {
    console.error('ERROR: patch target file not found:', p.file)
    process.exit(1)
  }
  const src = fs.readFileSync(abs, 'utf8')
  const already = src.includes(p.sentinel)
  if (!already) {
    for (const e of p.edits) {
      if (!src.includes(e.anchor)) {
        console.error('ERROR: anchor not found in', p.file)
        console.error('  Expected (first 200 chars):')
        console.error('  ' + e.anchor.slice(0, 200).replace(/\n/g, '\n  '))
        process.exit(1)
      }
    }
  }
  patchStates.push({ patch: p, abs, src, alreadyPatched: already })
}

// All-already-done shortcut.
const allFileDropsExist = FILE_DROPS.every((rel) =>
  fs.existsSync(path.resolve(repo, rel))
)
const allPatched = patchStates.every((s) => s.alreadyPatched)
if (allFileDropsExist && allPatched) {
  console.log('✓ All file drops and patches already applied. No changes made.')
  process.exit(0)
}

// ── Apply file drops ─────────────────────────────────────────────────────

for (const rel of FILE_DROPS) {
  const src = path.join(filesDir, rel)
  const dst = path.resolve(repo, rel)
  if (fs.existsSync(dst)) {
    console.log('• ' + rel + ': already exists, skipping')
    continue
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log('✓ Created ' + rel)
}

// ── Apply patches ────────────────────────────────────────────────────────

for (const { patch, abs, src, alreadyPatched } of patchStates) {
  if (alreadyPatched) {
    console.log('• ' + patch.label + ': already patched, skipping')
    continue
  }
  let next = src
  for (const e of patch.edits) {
    next = next.replace(e.anchor, e.replacement)
  }
  fs.writeFileSync(abs, next)
  console.log('✓ Patched ' + patch.file)
}

console.log('')
console.log('Foundation bundle applied. Next steps:')
console.log('  1. npx tsc --noEmit                  # type-check')
console.log('  2. npm run db:migrate                # apply migration (hits shared dev/prod DB)')
console.log('  3. tsx scripts/smoke-opportunity-bank.ts')
console.log('  4. git diff                          # eyeball the patches')
console.log('  5. Optional package.json: add "smoke:opportunity-bank":')
console.log('       "tsx scripts/smoke-opportunity-bank.ts"')
