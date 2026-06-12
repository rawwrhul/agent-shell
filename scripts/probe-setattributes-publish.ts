#!/usr/bin/env -S npx tsx
// scripts/probe-setattributes-publish.ts
//
// Tests the hypothesis from the version-source probe: that the proper way
// to update an existing CollectionItem is `item.setAttributes(...)` rather
// than `blog.addItems([{ id, slug, fieldData }])`. If true, this avoids the
// publishForAgent version error that addItems-with-id triggers.
//
// Flow:
//   1. Refuse to run if workspace is dirty
//   2. Read the offshore-paralegal item
//   3. Call item.setAttributes({ fieldData: { ...current, [imageId]: <test URL> } })
//   4. Call framer.publishForAgent({ action: 'preview' }) — log success or failure
//   5. ALWAYS revert via framer.rejectAllPending() before exiting
//   6. Verify workspace is clean afterward
//
// Never confirms or deploys. Production untouched.
//
// Run from repo root:
//   PEXELS_API_KEY=$(gcloud secrets versions access latest --secret=pexels-api-key) npx tsx scripts/probe-setattributes-publish.ts

import { getTenant }         from '../src/tenants/registry'
import { withFramerSession } from '../src/integrations/framer/client'
import {
  findBlogCollection,
  findBlogItemBySlug,
  resolveBlogFieldIdsExtended,
} from '../src/integrations/framer/cms-write'

const SLUG     = 'offshore-paralegal-hire-australia'
const TEST_URL = 'https://images.pexels.com/photos/8111865/pexels-photo-8111865.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200'

function changesTotal(cp: any): number {
  return (cp?.added?.length ?? 0) + (cp?.removed?.length ?? 0) + (cp?.modified?.length ?? 0)
}

async function main() {
  const tenant = await getTenant('tarino')

  let probeOutcome:    'preview_ok' | 'preview_failed' | 'setattrs_failed' | 'unknown' = 'unknown'
  let probeError:      string | null = null
  let revertSucceeded  = false

  await withFramerSession(tenant, async (framer) => {
    const f = framer as any

    // 1. Pre-flight clean
    const cpBefore = await framer.getChangedPaths()
    if (changesTotal(cpBefore) > 0) {
      throw new Error(`Workspace dirty (${changesTotal(cpBefore)} pending) — clear in Framer first.`)
    }
    console.log('Pre-flight clean: 0 pending changes')

    // 2. Find item
    const blog = await findBlogCollection(framer)
    const item = await findBlogItemBySlug(blog, SLUG)
    const ids  = await resolveBlogFieldIdsExtended(blog)
    if (!ids.imageId) throw new Error('No Image field on Blog collection')

    console.log(`Target item: id=${item.id} slug=${item.slug}`)

    // 3. setAttributes
    try {
      console.log('Calling item.setAttributes({ fieldData: { ...current, image: TEST_URL } })...')
      await (item as any).setAttributes({
        fieldData: {
          ...item.fieldData,
          [ids.imageId]: { type: 'image', value: TEST_URL },
        },
      })
      console.log('✅ setAttributes succeeded.')
    } catch (e) {
      probeOutcome = 'setattrs_failed'
      probeError   = String(e).slice(0, 800)
      console.error('✗ setAttributes threw:', probeError)
      return
    }

    // Check changed paths
    const cpAfter = await framer.getChangedPaths()
    console.log(`Changed paths after setAttributes: ${changesTotal(cpAfter)} pending`)
    console.log(JSON.stringify(cpAfter, null, 2).slice(0, 500))

    // 4. publishForAgent preview
    try {
      console.log('Calling framer.publishForAgent({ action: "preview" })...')
      const preview = await f.publishForAgent({ action: 'preview' })
      probeOutcome = 'preview_ok'
      console.log('✅ preview succeeded!')
      console.log(JSON.stringify(preview, null, 2).slice(0, 1500))
    } catch (e) {
      probeOutcome = 'preview_failed'
      probeError   = String(e).slice(0, 800)
      console.error('✗ preview threw:', probeError)
    }

    // 5. Always revert
    try {
      console.log('\nReverting via framer.rejectAllPending()...')
      if (typeof f.rejectAllPending !== 'function') {
        console.warn('⚠  rejectAllPending not available — workspace WILL be left dirty.')
      } else {
        await f.rejectAllPending()
        const cpAfterRevert = await framer.getChangedPaths()
        const remaining = changesTotal(cpAfterRevert)
        if (remaining === 0) {
          revertSucceeded = true
          console.log('✅ revert clean: 0 pending changes.')
        } else {
          console.warn(`⚠  ${remaining} pending changes remain after rejectAllPending — manual cleanup may be needed.`)
        }
      }
    } catch (e) {
      console.error('✗ revert threw:', String(e).slice(0, 500))
    }
  })

  console.log('')
  console.log('=== Probe verdict ===')
  console.log('Outcome:        ', probeOutcome)
  console.log('Error (if any): ', probeError ?? '(none)')
  console.log('Revert clean:   ', revertSucceeded ? 'yes' : 'NO — check Framer UI manually')

  if (probeOutcome === 'preview_ok') {
    console.log('')
    console.log('🎯 HYPOTHESIS CONFIRMED: item.setAttributes is the right update path.')
    console.log('   Next: patch cms-write.ts to use setAttributes instead of addItems for updates.')
  } else if (probeOutcome === 'preview_failed') {
    console.log('')
    console.log('Hypothesis incorrect — setAttributes works for the write but preview still fails.')
    console.log('Need a different theory. Inspect the error above for what publishForAgent now wants.')
  } else if (probeOutcome === 'setattrs_failed') {
    console.log('')
    console.log('setAttributes itself rejected — need to inspect the error for the right call shape.')
  }
}

main().catch((err) => {
  console.error('\n✗ probe FATAL:', err?.stack ?? err)
  console.error('\nIf the workspace is left dirty, open Framer and revert manually.')
  process.exit(1)
})
