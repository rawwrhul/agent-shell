// scripts/set-credential.ts
//
// Usage:
//   DATABASE_URL='...' CREDENTIAL_ENCRYPTION_KEY='...' \
//     npx ts-node scripts/set-credential.ts <tenant_id> <integration> <secret>
//
// Examples:
//   # Framer API key for tarino
//   ... set-credential.ts tarino framer "fr_live_xxxxx"
//
//   # DataForSEO credentials for tarino (login:password format)
//   ... set-credential.ts tarino dataforseo "you@example.com:apikey123"
//
// The script prints the encrypted blob length so you can confirm storage,
// then exits cleanly. Run from a trusted machine — the plaintext secret
// appears on the command line (and therefore in shell history; clear it
// with `history -d` after running).

import { storeCredential } from '../src/integrations/storage'

async function main() {
  const [tenantId, integration, secret, ...metaArgs] = process.argv.slice(2)

  if (!tenantId || !integration || !secret) {
    console.error('Usage: set-credential.ts <tenant_id> <integration> <secret> [metaKey=value ...]')
    console.error('Integrations: framer, dataforseo')
    process.exit(1)
  }

  const meta: Record<string, string> = {}
  for (const arg of metaArgs) {
    const eq = arg.indexOf('=')
    if (eq > 0) meta[arg.slice(0, eq)] = arg.slice(eq + 1)
  }

  await storeCredential(tenantId, integration, secret, meta)
  console.log(`Stored ${integration} credentials for tenant ${tenantId}.`)
  console.log(`Meta: ${JSON.stringify(meta)}`)
  process.exit(0)
}

main().catch(err => {
  console.error('set-credential failed:', err)
  process.exit(1)
})
