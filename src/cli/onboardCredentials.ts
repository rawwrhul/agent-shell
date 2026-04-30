#!/usr/bin/env tsx
// src/cli/onboardCredentials.ts — add skill credentials for an existing client
// Usage: npm run onboard:creds <tenant-id>
import * as rl from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import 'dotenv/config'
import { listActiveTenants } from '../tenants/registry'
import { AGENT_CREDENTIAL_MANIFESTS } from '../credentials/manifest'
import { getClientCredential } from '../credentials/resolver'
import { config } from '../config'

const secrets = new SecretManagerServiceClient()

async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) { console.error('Usage: npm run onboard:creds <tenant-id>'); process.exit(1) }

  const tenants = await listActiveTenants()
  const tenant  = tenants.find(t => t.tenant_id === tenantId)
  if (!tenant) { console.error(`Tenant '${tenantId}' not found.`); process.exit(1) }

  const manifest = AGENT_CREDENTIAL_MANIFESTS[tenant.agent_type] ?? []
  if (!manifest.length) { console.log(`No client credentials needed for '${tenant.agent_type}'.`); process.exit(0) }

  const io = rl.createInterface({ input, output })
  console.log(`\n══════════════════════════════════════════\n  Credentials for: ${tenant.client_name}\n  Agent: ${tenant.agent_type}\n══════════════════════════════════════════\n`)

  for (const cred of manifest) {
    const existing  = await getClientCredential(tenantId, cred.key)
    const req       = cred.required ? ' [REQUIRED]' : ' [optional]'
    const current   = existing ? ' (set — press Enter to keep)' : ''
    console.log(`\n── ${cred.label}${req} ──────────────────`)
    console.log(`   ${cred.description}`)
    console.log(`   How to get: ${cred.howToGet}`)
    const val = await io.question(`   Value${current}: `)
    if (!val.trim() && existing) { console.log('   Kept.'); continue }
    if (!val.trim()) { console.log('   Skipped.'); continue }
    await storeSecret(`${tenantId}-${cred.key}`, val.trim(), secrets)
    console.log(`   ✅ Stored`)
  }

  io.close()
  console.log(`\n✅ Done. Run: npm run creds:check ${tenantId}\n`)
}

async function storeSecret(id: string, value: string, s: SecretManagerServiceClient) {
  const parent = `projects/${config.GCP_PROJECT_ID}`, name = `${parent}/secrets/${id}`
  try { await s.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } }) }
  catch { await s.createSecret({ parent, secretId: id, secret: { replication: { automatic: {} } } }); await s.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } }) }
}

main().catch(err => { console.error(err); process.exit(1) })
