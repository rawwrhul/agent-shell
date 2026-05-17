// src/cli/audit.ts
//
// Manual audit runner. Doesn't trigger a crawl — runs against whatever crawl
// data is already in the DB. For crawl-then-audit, run `npm run crawl <t>`
// first or use the runFullAuditCycle scheduler path.
//
// Usage:
//   npm run audit tarino
//   npm run audit tarino --cycle    # crawl + audit in one shot
//
// Exits 0 on completion, 1 on tenant-not-found or fatal error.

import 'dotenv/config'
import { runAudit, runFullAuditCycle } from '../skills/seo-technical-auditor'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const tenantId = args.find((a) => !a.startsWith('--'))
  const doCycle = args.includes('--cycle')

  if (!tenantId) {
    console.error('Usage: npm run audit <tenantId> [--cycle]')
    process.exit(1)
  }

  console.log(`\n→ Auditing ${tenantId}${doCycle ? ' (with fresh crawl)' : ' (against existing crawl data)'}\n`)

  const t0 = Date.now()
  const summary = doCycle
    ? await runFullAuditCycle(tenantId)
    : await runAudit(tenantId)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  console.log(`\n✅ Audit ${summary.status} in ${elapsed}s`)
  console.log(`   Audit run ID:  ${summary.auditRunId}`)
  console.log(`   Findings:      ${summary.findingsTotal} total`)
  console.log(`     New:         ${summary.findingsNew}`)
  console.log(`     Persistent:  ${summary.findingsPersistent}`)
  console.log(`     Resolved:    ${summary.findingsResolved}`)
  console.log(`   Severities:    P0=${summary.severityCounts.P0}  P1=${summary.severityCounts.P1}  P2=${summary.severityCounts.P2}  P3=${summary.severityCounts.P3}`)
  console.log(`   Opportunities: ${summary.opportunitiesCreated}`)
  console.log()
  console.log('─── Audit narrative ───')
  console.log(summary.narrative)
  console.log()

  if (summary.status === 'failed') process.exit(1)
}

main().catch((err) => {
  console.error('audit CLI failed:', err)
  process.exit(1)
})
