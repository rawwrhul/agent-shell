#!/usr/bin/env tsx
import 'dotenv/config'
import { listActiveTenants } from '../tenants/registry'

async function main() {
  const tenants = await listActiveTenants()
  if (!tenants.length) { console.log('\nNo active tenants. Run: npm run onboard\n'); return }
  console.log(`\n${'─'.repeat(60)}\n  CGS Active Clients (${tenants.length})\n${'─'.repeat(60)}`)
  for (const t of tenants) {
    console.log(`\n  ${t.client_name}`)
    console.log(`  Tenant ID:  ${t.tenant_id}`)
    console.log(`  Agent:      ${t.agent_type}`)
    console.log(`  Skills:     ${Array.isArray(t.skills) ? t.skills.join(', ') : t.skills}`)
    console.log(`  Billing:    ${t.billing_tag}`)
    console.log(`  Created:    ${new Date(t.created_at).toLocaleDateString()}`)
  }
  console.log(`\n${'─'.repeat(60)}\n`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
