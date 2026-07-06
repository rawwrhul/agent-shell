#!/usr/bin/env tsx
// scripts/smoke-google-ads.ts
//
// Usage: npm run smoke:ads <tenant-id>
//
// Verifies the full chain: Secret Manager creds -> MCC auth -> tenant CID ->
// GAQL read. Read-only; consumes a handful of daily operations.

import 'dotenv/config'
import { listAccessibleCustomers, forTenant } from '../src/integrations/googleads/client'

async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) {
    console.error('Usage: npm run smoke:ads <tenant-id>')
    process.exit(1)
  }

  console.log('1/2 listAccessibleCustomers...')
  const cids = await listAccessibleCustomers()
  console.log(`    ${cids.length} account(s) directly visible: ${cids.join(', ') || '(none)'}`)

  console.log(`2/2 Reading up to 10 campaigns for tenant "${tenantId}"...`)
  const client = await forTenant(tenantId)
  const rows = await client.query(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type
    FROM campaign
    ORDER BY campaign.id
    LIMIT 10`, 'smoke')

  if (!rows.length) {
    console.log('    Account reachable, zero campaigns returned.')
  }
  for (const r of rows) {
    console.log(`    [${r.campaign?.status}] ${r.campaign?.id}  ${r.campaign?.name}  (${r.campaign?.bidding_strategy_type})`)
  }

  console.log('\n✅ Google Ads smoke test passed.')
}

main().catch((err) => { console.error(String(err)); process.exit(1) })
