#!/usr/bin/env tsx
// Usage: npm run google:check <tenant-id>
//
// Layer-by-layer diagnostic for a tenant's Google data access. Exists
// because GSC/GA4 failures are silent in agent runs (tool errors are
// returned as strings and summarized away) — "it never worked" hid for
// months. This prints exactly which layer is broken and how to fix it:
//
//   1. Tenant config     — gsc_site_url / ga4_property_id set?
//   2. API enablement    — SERVICE_DISABLED → gcloud services enable …
//   3. Access grant      — PERMISSION_DENIED → add the SA on the property
//   4. Data flows        — sample row counts from each source
//
// Note on local runs: ADC must carry the right scopes. Either run with SA
// impersonation, or: gcloud auth application-default login \
//   --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/analytics.readonly
// (and your own Google account must also be granted on the properties).
// In production the Cloud Run SA is used automatically.

import 'dotenv/config'
import { getTenant } from '../tenants/registry'
import { querySearchAnalytics } from '../integrations/gsc/client'
import { runReport } from '../integrations/ga4/client'

const SA_EMAIL_HINT = 'cgs-agent-shell-sa@<project>.iam.gserviceaccount.com (gcloud iam service-accounts list)'

function classify(err: unknown): string {
  const msg = String(err)
  if (msg.includes('SERVICE_DISABLED') || msg.includes('has not been used') || msg.includes('it is disabled')) {
    return 'API_DISABLED'
  }
  if (msg.includes('PERMISSION_DENIED') || msg.includes('does not have sufficient permission') || msg.includes('User does not have')) {
    return 'NO_GRANT'
  }
  if (msg.includes('NOT_FOUND') || msg.includes('not found')) return 'NOT_FOUND'
  if (msg.includes('invalid_grant') || msg.includes('Could not load the default credentials')) return 'ADC_BROKEN'
  return 'OTHER'
}

function daysAgoISO(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}

async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) { console.error('Usage: npm run google:check <tenant-id>'); process.exit(1) }

  console.log(`\nGoogle access check — tenant: ${tenantId}\n`)
  const tenant = await getTenant(tenantId)

  // ── GSC ──
  if (!tenant.gsc_site_url) {
    console.log('GSC  ⚪ gsc_site_url not set on tenant — skipping (set it via onboarding or Supabase)')
  } else {
    console.log(`GSC  site: ${tenant.gsc_site_url}`)
    try {
      const rows = await querySearchAnalytics(tenant, {
        startDate: daysAgoISO(7), endDate: daysAgoISO(1),
        dimensions: ['date'], rowLimit: 10,
      })
      console.log(`GSC  ✅ OK — ${rows.length} day-rows returned for the last week`)
      if (rows.length === 0) console.log('GSC  ⚠️  0 rows: property may be newly added, wrong type (sc-domain vs URL-prefix), or genuinely no traffic')
    } catch (err) {
      const kind = classify(err)
      console.log(`GSC  ❌ ${kind}`)
      if (kind === 'API_DISABLED') console.log('     fix: gcloud services enable searchconsole.googleapis.com')
      if (kind === 'NO_GRANT')     console.log(`     fix: Search Console → property → Settings → Users → add ${SA_EMAIL_HINT} as Full user`)
      if (kind === 'NOT_FOUND')    console.log('     fix: gsc_site_url does not match a property this account can see — check sc-domain: vs https:// form')
      if (kind === 'ADC_BROKEN')   console.log('     fix: gcloud auth application-default login (see header of this script for scopes)')
      console.log(`     raw: ${String(err).slice(0, 200)}`)
    }
  }

  // ── GA4 ──
  if (!tenant.ga4_property_id) {
    console.log('GA4  ⚪ ga4_property_id not set on tenant — skipping')
  } else {
    console.log(`GA4  property: ${tenant.ga4_property_id}`)
    try {
      const res = await runReport(tenant, {
        startDate: daysAgoISO(7), endDate: daysAgoISO(1),
        dimensions: ['date'], metrics: ['sessions'], limit: 10,
      })
      console.log(`GA4  ✅ OK — ${res.rowCount} day-rows, sample sessions: ${res.rows[0]?.metricValues[0] ?? 'n/a'}`)
    } catch (err) {
      const kind = classify(err)
      console.log(`GA4  ❌ ${kind}`)
      if (kind === 'API_DISABLED') console.log('     fix: gcloud services enable analyticsdata.googleapis.com')
      if (kind === 'NO_GRANT')     console.log(`     fix: GA4 → Admin → Property access management → add ${SA_EMAIL_HINT} as Viewer`)
      if (kind === 'NOT_FOUND')    console.log('     fix: ga4_property_id must be the NUMERIC property id, not the G-XXXX measurement id')
      if (kind === 'ADC_BROKEN')   console.log('     fix: gcloud auth application-default login (see header of this script for scopes)')
      console.log(`     raw: ${String(err).slice(0, 200)}`)
    }
  }

  console.log('')
  process.exit(0)
}

main().catch(err => { console.error('google:check failed:', err); process.exit(1) })
