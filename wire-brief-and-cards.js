// wire-brief-and-cards.js
//
// Bundle: tenant business_brief + unified approval cards for bank-surfaced opportunities.
//
// Drops 3 new files:
//   - db/migrations/business-brief-and-cards.ts
//   - src/core/opportunity-bank/card-builder.ts
//   - scripts/smoke-brief-and-cards.ts
//
// Applies 9 patches:
//   - db/migrate.ts                                   register migration
//   - src/tenants/types.ts                            add businessBrief + operatorSlackUserId
//   - src/tenants/registry.ts                         map new fields from row
//   - src/core/outreach-drafter/index.ts              add businessBrief to DraftInput + inject in prompt
//   - src/skills/seo-backlink-prospector/index.ts     pass tenant.businessBrief to drafter
//   - src/skills/seo-brand-mention-monitor/index.ts   pass tenant.businessBrief to drafter
//   - src/orchestrator/aggregator.ts                  inject businessBrief + call card-builder after pickForDailyRun
//   - src/agents/subagent.ts                          inject businessBrief at top of specialist prompt
//   - src/hitl/handlers.ts                            dispatch outreach_send_mailto on approve

const fs   = require('fs')
const path = require('path')

const repo      = process.cwd()
const scriptDir = __dirname
const filesDir  = path.resolve(scriptDir, 'files')

// ── New file drops ──────────────────────────────────────────────────────

const FILE_DROPS = [
  'db/migrations/business-brief-and-cards.ts',
  'src/core/opportunity-bank/card-builder.ts',
  'scripts/smoke-brief-and-cards.ts',
]

// ── Patches ─────────────────────────────────────────────────────────────

const PATCHES = [
  {
    file:     'db/migrate.ts',
    label:    'db/migrate: register business-brief-and-cards migration',
    sentinel: `runBusinessBriefAndCardsMigration`,
    edits: [
      {
        anchor: `import { runSeo5BacklinksMigration }   from './migrations/seo-5-backlinks'`,
        replacement: `import { runSeo5BacklinksMigration }   from './migrations/seo-5-backlinks'
import { runBusinessBriefAndCardsMigration } from './migrations/business-brief-and-cards'`,
      },
      {
        anchor: `  await runSeo5BacklinksMigration(pool)`,
        replacement: `  await runSeo5BacklinksMigration(pool)
  await runBusinessBriefAndCardsMigration(pool)`,
      },
    ],
  },

  {
    file:     'src/tenants/types.ts',
    label:    'tenants/types: add businessBrief + operatorSlackUserId',
    sentinel: `operatorSlackUserId`,
    edits: [
      {
        anchor: `  /** Opportunity types this tenant has opted out of. Discovery skills
   *  honour this — they don't even file opportunities of disabled types. */
  disabledOpportunityTypes?: string[]`,
        replacement: `  /** Opportunity types this tenant has opted out of. Discovery skills
   *  honour this — they don't even file opportunities of disabled types. */
  disabledOpportunityTypes?: string[]

  /** Operator-authored 2-4 sentence description of what this tenant
   *  does, who they serve, how they're positioned. Injected into every
   *  LLM call (drafter, aggregator, subagent) as authoritative ground
   *  truth. Eliminates LLM industry-guessing failures. */
  businessBrief?: string

  /** Slack user ID of the operator to tag on approval cards that need
   *  human attention. Format: U07A1B2C3DE (no @). */
  operatorSlackUserId?: string`,
      },
      {
        anchor: `  competitor_domains:           string[] | null // R3
  disabled_opportunity_types:   string[] | null // SEO-5
  cron_timezone:                string | null   // R3`,
        replacement: `  competitor_domains:           string[] | null // R3
  disabled_opportunity_types:   string[] | null // SEO-5
  business_brief:               string | null   // Business-brief bundle
  operator_slack_user_id:       string | null   // Business-brief bundle
  cron_timezone:                string | null   // R3`,
      },
    ],
  },

  {
    file:     'src/tenants/registry.ts',
    label:    'tenants/registry: map businessBrief + operatorSlackUserId',
    sentinel: `operatorSlackUserId:`,
    edits: [
      {
        anchor: `    targetDomain:              row.target_domain ?? undefined,
    competitorDomains:         row.competitor_domains ?? undefined,
    disabledOpportunityTypes:  row.disabled_opportunity_types ?? undefined,
    cronTimezone:              row.cron_timezone ?? undefined,`,
        replacement: `    targetDomain:              row.target_domain ?? undefined,
    competitorDomains:         row.competitor_domains ?? undefined,
    disabledOpportunityTypes:  row.disabled_opportunity_types ?? undefined,
    cronTimezone:              row.cron_timezone ?? undefined,
    businessBrief:             row.business_brief ?? undefined,
    operatorSlackUserId:       row.operator_slack_user_id ?? undefined,`,
      },
    ],
  },

  {
    file:     'src/core/outreach-drafter/index.ts',
    label:    'outreach-drafter: accept + inject businessBrief',
    sentinel: `businessBrief`,
    edits: [
      {
        anchor: `export interface DraftInput {
  prospectType:  OutreachProspectType`,
        replacement: `export interface DraftInput {
  /** Operator-authored business brief — authoritative ground truth for
   *  what the tenant does. When provided, overrides any LLM inference
   *  about industry. */
  businessBrief?: string
  prospectType:  OutreachProspectType`,
      },
      {
        anchor: `function buildPrompt(input: DraftInput): string {
  const framingFn = TYPE_FRAMING[input.prospectType] ?? GENERIC_FRAMING
  const typeFraming = framingFn(input.targetSite)`,
        replacement: `function buildPrompt(input: DraftInput): string {
  const framingFn = TYPE_FRAMING[input.prospectType] ?? GENERIC_FRAMING
  const typeFraming = framingFn(input.targetSite)

  const businessBriefBlock = input.businessBrief
    ? \`\\n## About \${input.tenantName} — AUTHORITATIVE, do not infer or pattern-match against the name\\n\${input.businessBrief}\\n\\n\`
    : ''`,
      },
      {
        anchor: `  return \`You are drafting a real outreach email from \${input.tenantName} to the editor / owner of \${input.targetSite}. The email must read like a thoughtful operator wrote it — not like a generic SEO outreach template. No "I hope this email finds you well." No "I came across your incredible article." No flattery. No hype words.

\${typeFraming}`,
        replacement: `  return \`You are drafting a real outreach email from \${input.tenantName} to the editor / owner of \${input.targetSite}. The email must read like a thoughtful operator wrote it — not like a generic SEO outreach template. No "I hope this email finds you well." No "I came across your incredible article." No flattery. No hype words.
\${businessBriefBlock}
\${typeFraming}`,
      },
    ],
  },

  {
    file:     'src/skills/seo-backlink-prospector/index.ts',
    label:    'backlink-prospector: pass tenant.businessBrief to drafter',
    sentinel: `businessBrief: tenant.businessBrief`,
    edits: [
      {
        anchor: `      draft = await draftOutreach({
        prospectType: 'backlink_gap',
        targetSite:   p.sourceDomain,
        targetUrl:    p.sourceUrl,
        tenantName:   tenant.clientName,
        tenantDomain: tenant.targetDomain ?? '',
        ourUrl:       null,`,
        replacement: `      draft = await draftOutreach({
        businessBrief: tenant.businessBrief,
        prospectType: 'backlink_gap',
        targetSite:   p.sourceDomain,
        targetUrl:    p.sourceUrl,
        tenantName:   tenant.clientName,
        tenantDomain: tenant.targetDomain ?? '',
        ourUrl:       null,`,
      },
    ],
  },

  {
    file:     'src/skills/seo-brand-mention-monitor/index.ts',
    label:    'brand-mention-monitor: pass tenant.businessBrief to drafter',
    sentinel: `businessBrief: tenant.businessBrief`,
    edits: [
      {
        anchor: `      draft = await draftOutreach({
        prospectType: 'unlinked_mention',
        targetSite:   c.sourceDomain,
        targetUrl:    c.sourceUrl,
        tenantName:   tenant.clientName,
        tenantDomain: targetDomain,
        ourUrl:       null,`,
        replacement: `      draft = await draftOutreach({
        businessBrief: tenant.businessBrief,
        prospectType: 'unlinked_mention',
        targetSite:   c.sourceDomain,
        targetUrl:    c.sourceUrl,
        tenantName:   tenant.clientName,
        tenantDomain: targetDomain,
        ourUrl:       null,`,
      },
    ],
  },

  {
    file:     'src/orchestrator/aggregator.ts',
    label:    'aggregator: inject businessBrief + create approval cards for surfaced',
    sentinel: `createApprovalCardsForSurfaced`,
    edits: [
      {
        anchor: `import { pickForDailyRun } from '../core/opportunity-bank'`,
        replacement: `import { pickForDailyRun } from '../core/opportunity-bank'
import { createApprovalCardsForSurfaced } from '../core/opportunity-bank/card-builder'
import { pool as bankPool } from '../memory/postgres'`,
      },
      {
        anchor: `function buildDailySystem(tenant: TenantConfig): string {
  return \`You are the aggregator for \${tenant.clientName}'s daily \${tenant.agentType} run, built by Causal Growth Science.

The agent has just executed the daily SEO loop. Synthesise the outputs into a single structured daily report.`,
        replacement: `function buildDailySystem(tenant: TenantConfig): string {
  const businessBriefBlock = tenant.businessBrief
    ? \`\\n# About \${tenant.clientName} — AUTHORITATIVE ground truth, do not infer otherwise from the name\\n\${tenant.businessBrief}\\n\`
    : ''
  return \`You are the aggregator for \${tenant.clientName}'s daily \${tenant.agentType} run, built by Causal Growth Science.
\${businessBriefBlock}
The agent has just executed the daily SEO loop. Synthesise the outputs into a single structured daily report.`,
      },
      {
        anchor: `        if (surfaced.length > 0) {
          differentialBlock += '\\n\\n## Opportunities surfaced from the bank this run\\n\\n'
            + 'These were filed by background runs (audit, future discovery skills) and have just been promoted from the bank into this customer-facing batch. They are now status=surfaced with surfaced_in_run_id stamped to this task. **Include each of them in the \`newOpportunities\` array of your structured output**, alongside any new ones the specialist discovered inline.\\n\\n'
            + surfaced.map((o) =>
                \`- [\${o.priority}] \${o.type} (id: \${o.id}): \${o.description}\${o.target ? ' — ' + o.target : ''}\`
              ).join('\\n')
          logger.info('aggregator_surfaced_from_bank', {
            taskId: task.id, tenantId: task.tenantId, count: surfaced.length,
          })
        }`,
        replacement: `        if (surfaced.length > 0) {
          differentialBlock += '\\n\\n## Opportunities surfaced from the bank this run\\n\\n'
            + 'These were filed by background runs (audit, future discovery skills) and have just been promoted from the bank into this customer-facing batch. They are now status=surfaced with surfaced_in_run_id stamped to this task. **Include each of them in the \`newOpportunities\` array of your structured output**, alongside any new ones the specialist discovered inline. Each one also has its own approval card created — the operator will see Approve/Reject/Defer buttons inline in your final anchor message.\\n\\n'
            + surfaced.map((o) =>
                \`- [\${o.priority}] \${o.type} (id: \${o.id}): \${o.description}\${o.target ? ' — ' + o.target : ''}\`
              ).join('\\n')
          logger.info('aggregator_surfaced_from_bank', {
            taskId: task.id, tenantId: task.tenantId, count: surfaced.length,
          })

          // Create one approval_requests row per surfaced opportunity.
          // Aggregator's anchor message renderer picks these up via existing
          // query and inlines them as Block Kit action buttons.
          try {
            const cardResult = await createApprovalCardsForSurfaced({
              pool:          bankPool,
              opportunities: surfaced,
              taskId:        task.id,
              tenant,
            })
            logger.info('approval_cards_for_surfaced_complete', {
              taskId:             task.id,
              tenantId:           task.tenantId,
              cardsCreated:       cardResult.cardsCreated,
              autoExecuted:       cardResult.autoExecuted,
              skippedUnsupported: cardResult.skippedUnsupported,
              errorCount:         cardResult.errors.length,
            })
          } catch (err) {
            logger.warn('approval_cards_for_surfaced_failed', {
              taskId: task.id, err: String(err).slice(0, 300),
            })
          }
        }`,
      },
    ],
  },

  {
    file:     'src/agents/subagent.ts',
    label:    'subagent: inject businessBrief at top of specialist prompt',
    sentinel: `businessBrief — authoritative`,
    edits: [
      {
        anchor: `  return \`You are the \${subTask.specialist_name} for \${tenant.clientName}, an agent built by Causal Growth Science.`,
        replacement: `  const businessBriefBlock = tenant.businessBrief
    ? \`\\n# About \${tenant.clientName} — businessBrief — authoritative, do not infer otherwise\\n\${tenant.businessBrief}\\n\`
    : ''
  return \`You are the \${subTask.specialist_name} for \${tenant.clientName}, an agent built by Causal Growth Science.
\${businessBriefBlock}`,
      },
    ],
  },

  {
    file:     'src/hitl/handlers.ts',
    label:    'hitl/handlers: dispatch outreach_send_mailto on approve',
    sentinel: `outreach_send_mailto`,
    edits: [
      {
        anchor: `import { handleRejectionOnOpportunity } from '../core/opportunity-bank';`,
        replacement: `import { handleRejectionOnOpportunity } from '../core/opportunity-bank';
import { markProspectSent, canSendToday } from '../core/outreach-safety';`,
      },
      {
        anchor: `  await editMessageToResolved(ctx, resolved, 'approved');`,
        replacement: `  await editMessageToResolved(ctx, resolved, 'approved');

  // Bundle: business-brief-and-cards. Approve of an outreach card means
  // the operator has (or will) send the drafted email from their inbox.
  // We mark the outreach_queue row as 'sent' and enforce the daily cap.
  if (approval.toolName === 'outreach_send_mailto') {
    try {
      const ti = approval.toolInput as { outreach_queue_id?: string; target_site?: string }
      const cap = await canSendToday({ tenantId: approval.tenantId })
      if (!cap.allowed) {
        logger.warn('outreach_approve_daily_cap_hit', {
          approvalId: ctx.approvalId, tenantId: approval.tenantId,
          sentToday: cap.sentToday, cap: cap.cap,
        })
        // Approval already resolved — log it. Operator can manually
        // reverse via SQL if they want. For v1, soft warning only.
      }
      if (ti.outreach_queue_id) {
        await markProspectSent({ outreachQueueId: ti.outreach_queue_id })
      }
    } catch (err) {
      logger.warn('outreach_approve_mark_sent_failed', {
        approvalId: ctx.approvalId, err: String(err).slice(0, 300),
      })
    }
  }`,
      },
    ],
  },
]

// ── Pre-flight ───────────────────────────────────────────────────────────

if (!fs.existsSync(filesDir)) {
  console.error('ERROR: bundle files/ directory not found at', filesDir)
  process.exit(1)
}

for (const rel of FILE_DROPS) {
  const src = path.join(filesDir, rel)
  if (!fs.existsSync(src)) {
    console.error('ERROR: bundle source file missing:', src)
    process.exit(1)
  }
}

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
        console.error('  Sentinel: ' + p.sentinel)
        console.error('  Expected anchor (first 200 chars):')
        console.error('  ' + e.anchor.slice(0, 200).replace(/\n/g, '\n  '))
        process.exit(1)
      }
    }
  }
  patchStates.push({ patch: p, abs, src, alreadyPatched: already })
}

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
console.log('business_brief + unified approval cards bundle applied.')
console.log('')
console.log('Next steps:')
console.log('  1. npx tsc --noEmit')
console.log('  2. npm run db:migrate')
console.log('  3. npx tsx scripts/smoke-brief-and-cards.ts')
console.log('  4. Set Tarino business_brief + operator user ID via SQL (see DEPLOYMENT-BRIEF-AND-CARDS.md)')
console.log('  5. Re-fire backlink_prospect to test brief injection in drafts')
console.log('  6. Trigger a daily run to see approval cards in Slack')
