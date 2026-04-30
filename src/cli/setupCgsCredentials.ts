#!/usr/bin/env tsx
// Usage: npm run setup:cgs  (run once when setting up the platform)
import * as rl from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import 'dotenv/config'
import { CGS_CREDENTIALS } from '../credentials/manifest'
import { config } from '../config'

const secrets = new SecretManagerServiceClient()
const io = rl.createInterface({ input, output })

async function main() {
  console.log('\n══════════════════════════════════════════\n  CGS Agency Credentials Setup\n  (shared across all clients)\n══════════════════════════════════════════\n')

  for (const cred of CGS_CREDENTIALS) {
    console.log(`\n── ${cred.label} ──────────────────────`)
    console.log(`   ${cred.description}`)
    console.log(`   How to get: ${cred.howToGet}`)
    const val = await io.question('   Value (Enter to skip): ')
    if (!val.trim()) { console.log('   Skipped.'); continue }
    const id = `cgs-${cred.key}`, parent = `projects/${config.GCP_PROJECT_ID}`, name = `${parent}/secrets/${id}`
    try { await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(val.trim()) } }) }
    catch { await secrets.createSecret({ parent, secretId: id, secret: { replication: { automatic: {} } } }); await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(val.trim()) } }) }
    console.log(`   ✅ Stored as cgs-${cred.key}`)
  }

  io.close()
  console.log('\n✅ CGS credentials stored.\n')
}

main().catch(err => { console.error(err); process.exit(1) })
