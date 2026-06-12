#!/usr/bin/env -S npx tsx
// scripts/probe-framer-version-source.ts
//
// Read-only probe to find where Framer stashes the `version` field that
// publishForAgent({ action: 'preview' }) demands for UPDATES (but not creates).
//
// Dumps everything we can reach without writing:
//   1. framer.getPublishInfo()         — site-level publish/deploy info
//   2. framer.getDeployments()         — recent deployments
//   3. framer.getProjectInfo()         — project metadata
//   4. blog.getItems()                 — full keys + any version-like fields per item
//   5. CollectionItem method probe     — try item.draft / item.getVersion etc.
//   6. blog.getItem(id) if it exists   — sometimes returns richer item data than getItems()
//
// All read-only. Never calls addItems, removeItems, publishForAgent.
//
// Run from repo root:
//   PEXELS_API_KEY=$(gcloud secrets versions access latest --secret=pexels-api-key) npx tsx scripts/probe-framer-version-source.ts
//
// (PEXELS_API_KEY isn't strictly needed for this probe, but the tenant config
// loader may bootstrap clients that expect it. Cheaper to set it than debug
// startup errors.)

import { getTenant }         from '../src/tenants/registry'
import { withFramerSession } from '../src/integrations/framer/client'
import { findBlogCollection } from '../src/integrations/framer/cms-write'

const TARGET_SLUG = 'offshore-paralegal-hire-australia'

function dump(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`)
  try {
    console.log(JSON.stringify(value, (_k, v) => {
      if (typeof v === 'function') return '[Function]'
      if (typeof v === 'symbol')   return v.toString()
      return v
    }, 2))
  } catch (e) {
    console.log('  (unserializable):', String(e))
    console.log('  keys:', value && typeof value === 'object' ? Object.keys(value as object) : '(not object)')
  }
}

async function tryMethod(obj: any, method: string, args: any[] = []): Promise<{ ok: boolean; result?: unknown; err?: string }> {
  if (typeof obj?.[method] !== 'function') {
    return { ok: false, err: 'not a function' }
  }
  try {
    const result = await obj[method](...args)
    return { ok: true, result }
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 300) }
  }
}

async function main() {
  const tenant = await getTenant('tarino')

  await withFramerSession(tenant, async (framer) => {
    const f = framer as any

    // 1. Site-level info
    const pi = await tryMethod(f, 'getPublishInfo')
    dump('framer.getPublishInfo()', pi)

    const dep = await tryMethod(f, 'getDeployments')
    dump('framer.getDeployments()', dep)

    const proj = await tryMethod(f, 'getProjectInfo')
    dump('framer.getProjectInfo()', proj)

    // 2. List every method on framer that mentions 'version' or 'publish'
    const framerKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(f)).concat(Object.keys(f))
    const interesting = framerKeys.filter(k => /version|publish|deploy/i.test(k))
    console.log('\n=== framer methods/props matching version|publish|deploy ===')
    console.log(JSON.stringify(interesting, null, 2))

    // 3. Find Blog + an item
    const blog = await findBlogCollection(framer)
    const items = await blog.getItems()
    const target = items.find((i: any) => i.slug === TARGET_SLUG) ?? items[0]

    console.log('\n=== TARGET ITEM (full key inventory) ===')
    console.log('Slug:', target.slug, ' / id:', target.id)
    console.log('Own keys:', Object.keys(target))
    console.log('Proto keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(target)))

    // 4. Anything version-ish on the item
    const itemKeys = [
      ...Object.keys(target),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(target)),
    ]
    const versionish = itemKeys.filter(k => /version|draft|revision|hash|etag|seq/i.test(k))
    console.log('\n=== item fields matching version|draft|revision|hash|etag|seq ===')
    for (const k of versionish) {
      try {
        const v = (target as any)[k]
        if (typeof v === 'function') {
          // Try calling it (zero-arg getters)
          try {
            const result = await v.call(target)
            console.log(`  ${k}() →`, JSON.stringify(result)?.slice(0, 200))
          } catch (e) {
            console.log(`  ${k}() threw:`, String(e).slice(0, 100))
          }
        } else {
          console.log(`  ${k} =`, JSON.stringify(v)?.slice(0, 200))
        }
      } catch (e) {
        console.log(`  ${k} (read threw): ${String(e).slice(0, 100)}`)
      }
    }

    // 5. Try blog.getItem(id) if it exists
    const single = await tryMethod(blog, 'getItem', [target.id])
    if (single.ok) {
      console.log('\n=== blog.getItem(id) ===')
      console.log('Keys:', Object.keys(single.result as object))
      const sr = single.result as any
      const sv = Object.keys(sr).filter(k => /version|draft|revision|hash|etag|seq/i.test(k))
      console.log('version-like fields on getItem result:')
      for (const k of sv) console.log(`  ${k} =`, JSON.stringify(sr[k])?.slice(0, 200))
    } else {
      console.log('\n=== blog.getItem(id) === — not available:', single.err)
    }

    // 6. Look for methods on blog itself that might reveal version
    const blogProto = Object.getOwnPropertyNames(Object.getPrototypeOf(blog))
    const blogVersionish = blogProto.filter(k => /version|publish|deploy/i.test(k))
    console.log('\n=== blog methods matching version|publish|deploy ===')
    console.log(JSON.stringify(blogVersionish, null, 2))
  })

  console.log('\n✓ probe complete. Look for any non-undefined version-like field above.')
}

main().catch(err => {
  console.error('\n✗ probe failed:', err?.stack ?? err)
  process.exit(1)
})
