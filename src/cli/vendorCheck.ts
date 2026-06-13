#!/usr/bin/env tsx
// Usage: npm run vendor:check
//
// Verifies the CGS-shared Ahrefs and Surfer API keys actually work,
// in the same spirit as google:check — so a dead key surfaces here, not
// silently inside an agent run.
//
// Ahrefs: uses a FREE test query (target=ahrefs.com costs zero API units),
// so this check never spends from your unit allowance.
//
// Surfer: lists content editors (read-only). Also prints the raw response
// shape — used to finalize the shape-tolerant client's field mapping the
// first time a real key is available.

import 'dotenv/config'
import { ahrefsGet } from '../integrations/ahrefs/client'
import { surferRequest } from '../integrations/surfer/client'

function classify(err: unknown): string {
  const msg = String(err)
  if (msg.includes('not configured')) return 'KEY_NOT_SET'
  if (msg.includes('→ 401') || msg.includes('→ 403')) return 'BAD_KEY_OR_NO_API_ACCESS'
  if (msg.includes('→ 404')) return 'ENDPOINT_NOT_FOUND'
  if (msg.includes('→ 429')) return 'RATE_LIMITED'
  return 'OTHER'
}

async function main() {
  console.log('\nVendor API check\n')

  // ── Ahrefs (free test query — zero units) ──
  try {
    const res = await ahrefsGet('/site-explorer/domain-rating', {
      target: 'ahrefs.com', date: new Date().toISOString().slice(0, 10),
    })
    console.log('Ahrefs ✅ key valid (free test query, 0 units consumed)')
    console.log(`       sample: ${JSON.stringify(res).slice(0, 120)}`)
  } catch (err) {
    const kind = classify(err)
    console.log(`Ahrefs ❌ ${kind}`)
    if (kind === 'KEY_NOT_SET') console.log('       fix: npm run setup:cgs → ahrefs_api_key')
    if (kind === 'BAD_KEY_OR_NO_API_ACCESS') console.log('       fix: regenerate key in Ahrefs → Account → API keys; API v3 needs Lite plan or higher')
    console.log(`       raw: ${String(err).slice(0, 200)}`)
  }

  // ── Surfer ──
  try {
    const res = await surferRequest('GET', '/content_editors')
    console.log('Surfer ✅ key valid')
    console.log(`       response shape (for client field-mapping): ${JSON.stringify(res).slice(0, 400)}`)
  } catch (err) {
    const kind = classify(err)
    console.log(`Surfer ❌ ${kind}`)
    if (kind === 'KEY_NOT_SET') console.log('       fix: npm run setup:cgs → surfer_api_key')
    if (kind === 'BAD_KEY_OR_NO_API_ACCESS') console.log('       fix: Surfer API needs Custom Plan or API Add-on — contact Surfer support to enable, then regenerate the key')
    if (kind === 'ENDPOINT_NOT_FOUND') console.log('       note: key may be valid but this listing path differs on your plan — check the Swagger docs Surfer provides with API access')
    console.log(`       raw: ${String(err).slice(0, 200)}`)
  }

  console.log('')
  process.exit(0)
}

main().catch(err => { console.error('vendor:check failed:', err); process.exit(1) })
