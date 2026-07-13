#!/usr/bin/env tsx
// src/cli/adsLink.ts
//
// Usage: npm run ads:link <tenant-id> <customer-id>
//
// Stores the tenant's Google Ads customer id in Secret Manager as
// {tenant}-google_ads_customer_id, then verifies end-to-end access by
// reading one row from the account through the MCC. Requires the shared
// creds to already exist (npm run setup:cgs) and the client account to be
// linked under the CGS MCC in the Google Ads UI.

import 'dotenv/config'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { config } from '../config'
import { normalizeCid, TENANT_CUSTOMER_ID_KEY } from '../integrations/googleads/types'
import { forTenant, listAccessibleCustomers, probeCustomer } from '../integrations/googleads/client'

const secrets = new SecretManagerServiceClient()

async function storeSecret(secretId: string, value: string): Promise<void> {
  const parent = `projects/${config.GCP_PROJECT_ID}`
  const name = `${parent}/secrets/${secretId}`
  try {
    await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } })
  } catch {
    await secrets.createSecret({ parent, secretId, secret: { replication: { automatic: {} } } })
    await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } })
  }
}

async function main() {
  const [tenantId, rawCid] = process.argv.slice(2)
  if (!tenantId || !rawCid) {
    console.error('Usage: npm run ads:link <tenant-id> <customer-id>')
    process.exit(1)
  }

  const cid = normalizeCid(rawCid)
  const secretId = `${tenantId}-${TENANT_CUSTOMER_ID_KEY}`

  console.log(`\nLinking Google Ads account ${cid} to tenant "${tenantId}"`)

  console.log('1/4 Checking the CID is accessible under the MCC refresh token...')
  const accessible = await listAccessibleCustomers()
  if (!accessible.includes(cid)) {
    console.warn(`    ⚠️  ${cid} is not in listAccessibleCustomers (${accessible.length} accounts visible).`)
    console.warn('    This is expected for accounts linked UNDER the MCC (the list shows direct-access accounts).')
    console.warn('    Continuing - the read test below is the real verification.')
  } else {
    console.log('    ✅ CID visible to the refresh token.')
  }

  console.log('2/4 Probing the account (manager-account guard)...')
  const probe = await probeCustomer(cid)
  if (probe.isManager) {
    console.error(`    ❌ ${cid} (${probe.name ?? 'unnamed'}) is a MANAGER account (MCC).`)
    console.error('    The agent operates a single client account, never a manager - mutations')
    console.error('    against a manager CID fail, and reporting rows aggregate the wrong surface.')
    console.error('    Link one of its CHILD client accounts instead. If the customer\'s "account"')
    console.error('    is itself an MCC, see the manager-to-manager linking notes in the deployment')
    console.error('    guide and re-run ads:link with the child CID that actually runs the campaigns.')
    process.exit(1)
  }
  console.log(`    ✅ ${probe.name ?? '(no name)'} (${probe.id}, ${probe.currency ?? '?'}) is a client account.${probe.isTestAccount ? ' [test account]' : ''}`)

  console.log(`3/4 Storing secret ${secretId}...`)
  await storeSecret(secretId, cid)
  console.log('    ✅ Stored.')

  console.log('4/4 Verifying read access (one campaign row)...')
  const client = await forTenant(tenantId)
  const rows = await client.query(`
    SELECT customer.id, customer.descriptive_name, customer.currency_code
    FROM customer
    LIMIT 1`, 'ads_link_verify')
  const c = rows[0]?.customer
  if (!c?.id) throw new Error('Read verification returned no customer row')
  console.log(`    ✅ Connected: ${c.descriptive_name ?? '(no name)'} (${c.id}, ${c.currency_code ?? '?'})`)

  console.log(`\n✅ Tenant "${tenantId}" linked to Google Ads account ${cid}.`)
  console.log(`   Enable the integration by adding 'googleads' to the tenant's integrations array.\n`)
}

main().catch((err) => { console.error(String(err)); process.exit(1) })
