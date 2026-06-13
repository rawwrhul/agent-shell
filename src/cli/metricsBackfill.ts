#!/usr/bin/env tsx
// Usage: npm run metrics:backfill <tenant-id> [months]
//
// Backfill ranking_history (GSC, up to 16 months available) and
// traffic_history (GA4) for a tenant, month-by-month oldest-first.
// Safe to interrupt and re-run: every window is an idempotent upsert.
//
// Run this right after onboarding a client — they start with a year of
// baseline instead of an empty dashboard.

import 'dotenv/config'
import { pool } from '../memory/postgres'
import { getTenant } from '../tenants/registry'
import { syncGscWindow } from '../integrations/gsc/sync'
import { syncGa4Window } from '../integrations/ga4/sync'

function iso(d: Date): string { return d.toISOString().slice(0, 10) }

function monthWindows(months: number): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = []
  const today = new Date()
  for (let m = months; m >= 1; m--) {
    const start = new Date(today); start.setUTCMonth(start.getUTCMonth() - m); start.setUTCDate(1)
    const end   = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
    out.push({ start: iso(start), end: iso(end) })
  }
  // Current partial month up to yesterday.
  const cur = new Date(today); cur.setUTCDate(1)
  const yest = new Date(today.getTime() - 86_400_000)
  if (iso(cur) <= iso(yest)) out.push({ start: iso(cur), end: iso(yest) })
  return out
}

async function main() {
  const tenantId = process.argv[2]
  const months   = Math.min(Number(process.argv[3] ?? 12), 16)
  if (!tenantId) { console.error('Usage: npm run metrics:backfill <tenant-id> [months]'); process.exit(1) }

  const tenant = await getTenant(tenantId)
  const doGsc = tenant.integrations?.includes('gsc') && !!tenant.gsc_site_url
  const doGa4 = tenant.integrations?.includes('ga4') && !!tenant.ga4_property_id
  console.log(`\nBackfilling ${tenantId} — ${months} months  (GSC: ${doGsc ? 'yes' : 'no'}, GA4: ${doGa4 ? 'yes' : 'no'})\n`)
  if (!doGsc && !doGa4) { console.error('Nothing to do: enable gsc/ga4 integration and set config first.'); process.exit(1) }

  let gscTotal = 0, ga4Total = 0
  for (const w of monthWindows(months)) {
    process.stdout.write(`${w.start} → ${w.end}  `)
    if (doGsc) {
      try { const r = await syncGscWindow(pool, tenant, w.start, w.end); gscTotal += r.rows; process.stdout.write(`gsc:${r.rows} `) }
      catch (err) { process.stdout.write(`gsc:ERR `); console.error(`\n  gsc error: ${String(err).slice(0, 200)}\n  hint: npm run google:check ${tenantId}`) }
    }
    if (doGa4) {
      try { const r = await syncGa4Window(pool, tenant, w.start, w.end); ga4Total += r.rows; process.stdout.write(`ga4:${r.rows}`) }
      catch (err) { process.stdout.write(`ga4:ERR`); console.error(`\n  ga4 error: ${String(err).slice(0, 200)}`) }
    }
    process.stdout.write('\n')
  }

  console.log(`\n✅ Backfill complete — ranking_history +${gscTotal} rows, traffic_history +${ga4Total} rows\n`)
  process.exit(0)
}

main().catch(err => { console.error('Backfill failed:', err); process.exit(1) })
