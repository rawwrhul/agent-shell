#!/usr/bin/env tsx
// Usage: npm run creds:check [tenant-id]
import 'dotenv/config'
import { listActiveTenants } from '../tenants/registry'
import { getSharedCredential, getClientCredential } from '../credentials/resolver'
import { CGS_CREDENTIALS, AGENT_CREDENTIAL_MANIFESTS } from '../credentials/manifest'

async function main() {
  const filter = process.argv[2]

  console.log('\n══════════════════════════════════════════\n  CGS Credentials Audit\n══════════════════════════════════════════')
  console.log('\n── Agency (shared) credentials ────────────')
  for (const c of CGS_CREDENTIALS) {
    const v = await getSharedCredential(c.key)
    console.log(`  ${v ? '✅' : '⚪'} ${c.label}${!v && c.required ? ' ← REQUIRED' : ''}`)
  }

  const tenants = await listActiveTenants()
  const toCheck = filter ? tenants.filter(t => t.tenant_id === filter) : tenants

  for (const t of toCheck) {
    const manifest = AGENT_CREDENTIAL_MANIFESTS[t.agent_type] ?? []
    console.log(`\n── ${t.client_name} (${t.tenant_id}) · ${t.agent_type} ────────────`)
    let missingReq = 0
    for (const c of manifest) {
      const v = await getClientCredential(t.tenant_id, c.key)
      const status = v ? '✅' : c.required ? '❌ MISSING' : '⚪ optional'
      console.log(`  ${status}  ${c.label}`)
      if (!v && c.required) { missingReq++; console.log(`              How to get: ${c.howToGet}`) }
    }
    if (missingReq) console.log(`\n  ⚠️  ${missingReq} required credential(s) missing — run: npm run onboard:creds ${t.tenant_id}`)
    else            console.log('\n  ✅ All required credentials configured.')
  }
  console.log('')
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
