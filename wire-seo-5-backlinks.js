// wire-seo-5-backlinks.js
//
// SEO-5 Phase 1: backlink prospecting + brand mention monitoring + outreach
// drafter + spam-safety caps. Builds on the opportunity-bank foundation —
// new discovery skills file `pursue_backlink` and `fix_unlinked_mention`
// opportunities that the daily run already surfaces automatically.
//
// File drops (10):
//   - db/migrations/seo-5-backlinks.ts
//   - src/core/outreach-safety/index.ts
//   - src/core/outreach-drafter/index.ts
//   - src/skills/seo-backlink-prospector/{types,store,inventory,competitor-gap,index}.ts
//   - src/skills/seo-brand-mention-monitor/index.ts
//   - scripts/smoke-seo-5.ts
//
// Surgical patches (8):
//   - db/migrate.ts                              register migration
//   - src/integrations/dataforseo/client.ts      add backlinksList endpoint
//   - src/tenants/types.ts                       add disabledOpportunityTypes field
//   - src/tenants/registry.ts                    map targetDomain/competitorDomains/disabled* from row
//   - src/scheduler/types.ts                     extend RunKind enum
//   - src/scheduler/worker.ts                    fork on new runKinds
//   - src/scheduler/config.ts                    add new entries to DEFAULT_SCHEDULES
//   - src/tenants/slackManager.ts                accept runKind argument on secretchrontest

const fs   = require('fs')
const path = require('path')

const repo      = process.cwd()
const scriptDir = __dirname
const filesDir  = path.resolve(scriptDir, 'files')

// ── New file drops ──────────────────────────────────────────────────────

const FILE_DROPS = [
  'db/migrations/seo-5-backlinks.ts',
  'src/core/outreach-safety/index.ts',
  'src/core/outreach-drafter/index.ts',
  'src/skills/seo-backlink-prospector/types.ts',
  'src/skills/seo-backlink-prospector/store.ts',
  'src/skills/seo-backlink-prospector/inventory.ts',
  'src/skills/seo-backlink-prospector/competitor-gap.ts',
  'src/skills/seo-backlink-prospector/index.ts',
  'src/skills/seo-brand-mention-monitor/index.ts',
  'scripts/smoke-seo-5.ts',
]

// ── Patches ─────────────────────────────────────────────────────────────

const PATCHES = [
  {
    file:     'db/migrate.ts',
    label:    'db/migrate: register seo-5-backlinks migration',
    sentinel: `runSeo5BacklinksMigration`,
    edits: [
      {
        anchor: `import { runOpportunityBankMigration } from './migrations/opportunity-bank'`,
        replacement: `import { runOpportunityBankMigration } from './migrations/opportunity-bank'
import { runSeo5BacklinksMigration }   from './migrations/seo-5-backlinks'`,
      },
      {
        anchor: `  await runOpportunityBankMigration(pool)`,
        replacement: `  await runOpportunityBankMigration(pool)
  await runSeo5BacklinksMigration(pool)`,
      },
    ],
  },

  {
    file:     'src/integrations/dataforseo/client.ts',
    label:    'dataforseo: add backlinksList endpoint',
    sentinel: `export async function backlinksList`,
    edits: [
      {
        anchor: `export async function competitorsDomain(
  tenant: TenantConfig,
  args:   { target: string; limit?: number; locationCode?: number; languageCode?: string },
): Promise<CompetitorDomainItem[]> {
  type R = { tasks?: Array<{ result?: Array<{ items?: CompetitorDomainItem[] }> }> }
  const r = await call<R>(tenant, '/v3/dataforseo_labs/google/competitors_domain/live', [{
    target:         args.target,
    location_code:  args.locationCode ?? 2036,    // 2036 = Australia
    language_code:  args.languageCode ?? 'en',
    limit:          args.limit ?? 10,
    exclude_top_domains: true,                     // skip Wikipedia / news / generic
  }])
  return r.tasks?.[0]?.result?.[0]?.items ?? []
}`,
        replacement: `export async function competitorsDomain(
  tenant: TenantConfig,
  args:   { target: string; limit?: number; locationCode?: number; languageCode?: string },
): Promise<CompetitorDomainItem[]> {
  type R = { tasks?: Array<{ result?: Array<{ items?: CompetitorDomainItem[] }> }> }
  const r = await call<R>(tenant, '/v3/dataforseo_labs/google/competitors_domain/live', [{
    target:         args.target,
    location_code:  args.locationCode ?? 2036,    // 2036 = Australia
    language_code:  args.languageCode ?? 'en',
    limit:          args.limit ?? 10,
    exclude_top_domains: true,                     // skip Wikipedia / news / generic
  }])
  return r.tasks?.[0]?.result?.[0]?.items ?? []
}

// ── Backlinks list (SEO-5) ────────────────────────────────────────────────

export interface BacklinkListItem {
  source_url:    string
  source_domain: string
  target_url?:   string
  anchor?:       string
  source_rank?:  number
  dofollow?:     boolean
  first_seen?:   string
  last_seen?:    string
}

/**
 * Pulls actual backlink rows (not just summary counts). Used by SEO-5
 * backlink prospector for both inventory refresh and competitor gap diff.
 * Returns up to \`limit\` rows ordered by source rank descending.
 */
export async function backlinksList(
  tenant: TenantConfig,
  args:   { target: string; limit?: number },
): Promise<BacklinkListItem[]> {
  type R = { tasks?: Array<{ result?: Array<{ items?: BacklinkListItem[] }> }> }
  const r = await call<R>(tenant, '/v3/backlinks/backlinks/live', [{
    target:              args.target,
    limit:               args.limit ?? 100,
    mode:                'as_is',          // raw rows, not domain-rolled-up
    include_subdomains:  true,
    order_by:            ['rank,desc'],
    filters:             [['dofollow', '=', true]],
  }])
  return r.tasks?.[0]?.result?.[0]?.items ?? []
}`,
      },
    ],
  },

  {
    file:     'src/tenants/types.ts',
    label:    'tenants/types: add disabledOpportunityTypes field',
    sentinel: `disabledOpportunityTypes`,
    edits: [
      {
        anchor: `  /** Optional list of competitor domains. Used by competitor analyst. */
  competitorDomains?: string[]`,
        replacement: `  /** Optional list of competitor domains. Used by competitor analyst. */
  competitorDomains?: string[]

  /** Opportunity types this tenant has opted out of. Discovery skills
   *  honour this — they don't even file opportunities of disabled types. */
  disabledOpportunityTypes?: string[]`,
      },
      {
        anchor: `  competitor_domains:           string[] | null // R3
  cron_timezone:                string | null   // R3`,
        replacement: `  competitor_domains:           string[] | null // R3
  disabled_opportunity_types:   string[] | null // SEO-5
  cron_timezone:                string | null   // R3`,
      },
    ],
  },

  {
    file:     'src/tenants/registry.ts',
    label:    'tenants/registry: map targetDomain/competitorDomains/disabled* from row',
    sentinel: `disabledOpportunityTypes:`,
    edits: [
      {
        anchor: `    gsc_site_url:       row.gsc_site_url ?? undefined,
    ga4_property_id:    row.ga4_property_id ?? undefined,
    framer_project_url: row.framer_project_url ?? undefined,
  }
}`,
        replacement: `    gsc_site_url:       row.gsc_site_url ?? undefined,
    ga4_property_id:    row.ga4_property_id ?? undefined,
    framer_project_url: row.framer_project_url ?? undefined,
    // R3 / SEO-5 fields previously missing from the resolver — added for
    // discovery skills that read tenant.targetDomain / competitorDomains /
    // disabledOpportunityTypes.
    targetDomain:              row.target_domain ?? undefined,
    competitorDomains:         row.competitor_domains ?? undefined,
    disabledOpportunityTypes:  row.disabled_opportunity_types ?? undefined,
    cronTimezone:              row.cron_timezone ?? undefined,
  }
}`,
      },
    ],
  },

  {
    file:     'src/scheduler/types.ts',
    label:    'scheduler/types: extend RunKind for SEO-5 runKinds',
    sentinel: `'backlink_prospect'`,
    edits: [
      {
        anchor: `export type RunKind = 'daily' | 'weekly' | 'end-of-week' | 'seo_audit'`,
        replacement: `export type RunKind = 'daily' | 'weekly' | 'end-of-week' | 'seo_audit' | 'backlink_prospect' | 'brand_mention_scan'`,
      },
    ],
  },

  {
    file:     'src/scheduler/worker.ts',
    label:    'scheduler/worker: fork on backlink_prospect and brand_mention_scan',
    sentinel: `runBacklinkProspectCycle`,
    edits: [
      {
        anchor: `import { runFullAuditCycle } from '../skills/seo-technical-auditor';`,
        replacement: `import { runFullAuditCycle } from '../skills/seo-technical-auditor';
import { runBacklinkProspectCycle } from '../skills/seo-backlink-prospector';
import { runBrandMentionScanCycle } from '../skills/seo-brand-mention-monitor';`,
      },
      {
        anchor: `  // seo_audit runs its own cycle (crawl + audit + memory) directly — does
  // NOT go through the orchestrator/aggregator. The next daily run consumes
  // the findings + opportunities the audit produced.
  if (runKind === 'seo_audit') {
    logger.info('seo_audit_cycle_starting', { tenantId });
    try {
      await runFullAuditCycle(tenantId);
      logger.info('seo_audit_cycle_completed', { tenantId });
    } catch (err) {
      logger.error('seo_audit_cycle_failed', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }`,
        replacement: `  // seo_audit runs its own cycle (crawl + audit + memory) directly — does
  // NOT go through the orchestrator/aggregator. The next daily run consumes
  // the findings + opportunities the audit produced.
  if (runKind === 'seo_audit') {
    logger.info('seo_audit_cycle_starting', { tenantId });
    try {
      await runFullAuditCycle(tenantId);
      logger.info('seo_audit_cycle_completed', { tenantId });
    } catch (err) {
      logger.error('seo_audit_cycle_failed', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  // SEO-5 discovery cycles — same pattern as seo_audit. Silent (no Slack
  // output); the next daily run picks up the opportunities they file.
  if (runKind === 'backlink_prospect') {
    logger.info('backlink_prospect_cycle_starting_from_worker', { tenantId });
    try {
      await runBacklinkProspectCycle(tenantId);
      logger.info('backlink_prospect_cycle_completed_from_worker', { tenantId });
    } catch (err) {
      logger.error('backlink_prospect_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  if (runKind === 'brand_mention_scan') {
    logger.info('brand_mention_scan_cycle_starting_from_worker', { tenantId });
    try {
      await runBrandMentionScanCycle(tenantId);
      logger.info('brand_mention_scan_cycle_completed_from_worker', { tenantId });
    } catch (err) {
      logger.error('brand_mention_scan_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }`,
      },
    ],
  },

  {
    file:     'src/scheduler/config.ts',
    label:    'scheduler/config: add SEO-5 default schedules',
    sentinel: `backlink_prospect:`,
    edits: [
      {
        anchor: `  seo_audit: {
    cronExpr: '0 0 * * 6',          // midnight Saturday (Sydney)
    timezone: 'Australia/Sydney',
  },
} as const`,
        replacement: `  seo_audit: {
    cronExpr: '0 0 * * 6',          // midnight Saturday (Sydney)
    timezone: 'Australia/Sydney',
  },
  backlink_prospect: {
    cronExpr: '0 2 * * 0',          // 2am Sunday (Sydney) — SEO-5
    timezone: 'Australia/Sydney',
  },
  brand_mention_scan: {
    cronExpr: '0 4 * * 0',          // 4am Sunday (Sydney) — SEO-5
    timezone: 'Australia/Sydney',
  },
} as const`,
      },
    ],
  },

  {
    file:     'src/tenants/slackManager.ts',
    label:    'slackManager: secretchrontest accepts runKind argument',
    sentinel: `requested === 'backlink'`,
    edits: [
      {
        anchor: `    if (prompt.toLowerCase().includes('secretchrontest')) {
      logger.info('adhoc_audit_trigger_received', {
        tenantId: tenant.tenantId,
        userId:   event.user ?? 'unknown',
      })
      try {
        await enqueueOneOffRun({ tenantId: tenant.tenantId, runKind: 'seo_audit' })
        await say({
          text:      \`:eyes: Trigger received. Queued one-off \\\`seo_audit\\\` cycle for *\${tenant.clientName}* — identical code path to the Saturday-midnight cron. Watch Cloud Run logs for \\\`seo_audit_cycle_completed\\\`. No further Slack output from this command.\`,
          thread_ts: event.ts,
        })`,
        replacement: `    if (prompt.toLowerCase().includes('secretchrontest')) {
      // Optional runKind argument: 'secretchrontest backlink' or
      // 'secretchrontest mention'. Defaults to 'seo_audit'.
      const cronArgMatch = prompt.toLowerCase().match(/secretchrontest\\s+(\\w+)/)
      const requested = cronArgMatch?.[1] ?? ''
      const runKind: 'seo_audit' | 'backlink_prospect' | 'brand_mention_scan' =
        (requested === 'backlink' || requested === 'backlink_prospect') ? 'backlink_prospect' :
        (requested === 'mention'  || requested === 'brand_mention_scan')  ? 'brand_mention_scan' :
        'seo_audit'
      logger.info('adhoc_audit_trigger_received', {
        tenantId: tenant.tenantId,
        userId:   event.user ?? 'unknown',
        runKind,
      })
      try {
        await enqueueOneOffRun({ tenantId: tenant.tenantId, runKind })
        await say({
          text:      \`:eyes: Trigger received. Queued one-off \\\`\${runKind}\\\` cycle for *\${tenant.clientName}* — identical code path to the corresponding cron. Watch Cloud Run logs for \\\`\${runKind}_cycle_completed\\\` (or the _from_worker variant). No further Slack output from this command.\`,
          thread_ts: event.ts,
        })`,
      },
    ],
  },
]

// ── Pre-flight ───────────────────────────────────────────────────────────

if (!fs.existsSync(filesDir)) {
  console.error('ERROR: bundle files/ directory not found at', filesDir)
  console.error('Make sure both wire-seo-5-backlinks.js AND the files/ directory are next to each other.')
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
        console.error('  Expected (first 200 chars):')
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
console.log('SEO-5 backlinks bundle applied. Next steps:')
console.log('  1. npx tsc --noEmit                        # type-check')
console.log('  2. npm run db:migrate                      # apply migration (shared dev/prod DB)')
console.log('  3. npx tsx scripts/smoke-seo-5.ts          # pure-function tests')
console.log('  4. (after merge) trigger via Slack:')
console.log('     @bot secretchrontest backlink')
console.log('     @bot secretchrontest mention')
