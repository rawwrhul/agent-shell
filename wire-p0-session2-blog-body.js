#!/usr/bin/env node
// wire-p0-session2-blog-body.js
//
// P0 Session 2: framer_update_blog_body (single-stage approval write executor).
//
// Updates the Content field (HTML formattedText) on an existing blog item,
// then publishes + deploys. Rides the cms-write infrastructure from session 1.
//
// Adds:
//   - execFramerUpdateBlogBody in executor.ts
//   - dispatcher entry for 'framer_update_blog_body'
//
// Idempotent. Safe to re-run.
//
// Run from repo root:  node wire-p0-session2-blog-body.js
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const FILES = {
  cmsWrite:   path.join(ROOT, 'src/integrations/framer/cms-write.ts'),
  executor:   path.join(ROOT, 'src/integrations/framer/executor.ts'),
  dispatcher: path.join(ROOT, 'src/execution/dispatcher.ts'),
}

function assertExists(p, why) {
  if (!fs.existsSync(p)) {
    console.error(`✗  missing: ${p} — ${why}`)
    process.exit(1)
  }
}
assertExists(FILES.cmsWrite,   'session 1 must run first to create this')
assertExists(FILES.executor,   '')
assertExists(FILES.dispatcher, '')

const cmsWriteContent = fs.readFileSync(FILES.cmsWrite, 'utf8')
if (!cmsWriteContent.includes('applyBlogItemEdit')) {
  console.error('✗  cms-write.ts is missing applyBlogItemEdit — session 1 was not applied cleanly')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch executor.ts — append execFramerUpdateBlogBody
// ─────────────────────────────────────────────────────────────────────────────

let executorContent = fs.readFileSync(FILES.executor, 'utf8')

if (executorContent.includes('execFramerUpdateBlogBody')) {
  console.log(`⚠  executor.ts already has execFramerUpdateBlogBody — skipping`)
} else {
  if (!executorContent.includes('applyBlogItemEdit') || !executorContent.includes('resolveBlogFieldIdsExtended')) {
    console.error('✗  executor.ts missing session 1 cms-write imports — session 1 was not applied cleanly')
    process.exit(1)
  }

  const EXECUTOR_BODY = `
// ── framer_update_blog_body ─────────────────────────────────────────────────
//
// Replaces the Content field (HTML formattedText) on an existing blog post,
// then publishes + deploys to production. Body changes are substantive — per
// operator's tier rules these are Tier A (double approval) but we render the
// FULL new HTML in the approval card so single-stage is acceptable when the
// operator reviews the content carefully before approving.
//
// Agent files propose_action with:
//   toolName:   'framer_update_blog_body'
//   toolInput:  { slug, newContent }
//   riskLevel:  'high'
//
// Use cases:
//   - Refreshing thin/stale content on existing posts
//   - Adding new sections or paragraphs to existing posts
//   - Inserting internal links (just embed <a href="..."> in the HTML)
//   - Replacing weak content with depth (research, examples, data)
//
// NOT for:
//   - Creating new posts (use approve_blog_pitch — two-stage with draft preview)
//   - Meta-only changes (use framer_update_blog_meta — much cheaper)

export interface UpdateBlogBodyInput {
  slug:       string
  newContent: string   // HTML in Framer formattedText format
}

export async function execFramerUpdateBlogBody(
  input: UpdateBlogBodyInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug) {
      return { ok: false, summary: 'slug is required', error: 'missing slug' }
    }
    if (!input.newContent) {
      return { ok: false, summary: 'newContent is required', error: 'missing newContent' }
    }
    // Guard against accidentally clobbering with near-empty content
    if (input.newContent.length < 50) {
      return {
        ok:      false,
        summary: \`Refusing to clobber existing body with \${input.newContent.length} chars of content — likely a malformed update\`,
        error:   'CONTENT_TOO_SHORT',
        detail:  { slug: input.slug, providedLength: input.newContent.length },
      }
    }

    const fieldIds = await fr.withFramerSession(ctx.tenant, async (framer) => {
      const blog = await findBlogCollection(framer)
      return resolveBlogFieldIdsExtended(blog)
    })

    const fieldUpdates = {
      [fieldIds.contentId]: { type: 'formattedText', value: input.newContent },
    }
    const changedFieldIds = [fieldIds.contentId]

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds,
    })

    // Compute char delta for telemetry
    const beforeContentLength = (() => {
      const before = editResult.before.find((s: any) => s.fieldId === fieldIds.contentId)
      return typeof before?.value === 'string' ? before.value.length : 0
    })()
    const afterContentLength = input.newContent.length
    const delta = afterContentLength - beforeContentLength

    // Count internal links inserted (for visibility into agent behaviour)
    const linkCount = (input.newContent.match(/<a\\s+href=/gi) ?? []).length

    logger.info('exec_framer_update_blog_body', {
      tenantId:            ctx.tenant.tenantId,
      taskId:              ctx.taskId,
      approvalId:          ctx.approvalId,
      slug:                input.slug,
      itemId:              editResult.itemId,
      beforeContentLength,
      afterContentLength,
      delta,
      linkCount,
    })

    const sign = delta >= 0 ? '+' : ''
    return {
      ok:      true,
      summary: \`Updated body content on \${editResult.productionUrl} (\${sign}\${delta} chars, \${linkCount} link\${linkCount === 1 ? '' : 's'})\`,
      detail:  {
        slug:                input.slug,
        itemId:              editResult.itemId,
        productionUrl:       editResult.productionUrl,
        deploymentId:        editResult.deploymentId,
        beforeContentLength,
        afterContentLength,
        delta,
        linkCount,
        // Keep full before/after snapshots in editResult — accessible via
        // execution_jobs.result for ad-hoc rollback. Not duplicated here to
        // avoid bloating the dispatcher result column.
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: \`framer_update_blog_body failed: \${String(err).slice(0, 160)}\`,
      error:   String(err).slice(0, 500),
    }
  }
}
`

  executorContent = executorContent.trimEnd() + '\n' + EXECUTOR_BODY
  fs.writeFileSync(FILES.executor, executorContent, 'utf8')
  console.log(`✅ patched ${path.relative(ROOT, FILES.executor)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch dispatcher.ts — add import + map entry
// ─────────────────────────────────────────────────────────────────────────────

let dispatcherContent = fs.readFileSync(FILES.dispatcher, 'utf8')

if (dispatcherContent.includes('execFramerUpdateBlogBody')) {
  console.log(`⚠  dispatcher.ts already has execFramerUpdateBlogBody — skipping`)
} else {
  const OLD_IMPORT =
`import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
  execFramerUpdateBlogMeta,
} from '../integrations/framer/executor'`

  const NEW_IMPORT =
`import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
  execFramerUpdateBlogMeta,
  execFramerUpdateBlogBody,
} from '../integrations/framer/executor'`

  if (!dispatcherContent.includes(OLD_IMPORT)) {
    console.error('✗  dispatcher.ts: import block does not match expected shape — was session 1 applied?')
    process.exit(1)
  }
  dispatcherContent = dispatcherContent.replace(OLD_IMPORT, NEW_IMPORT)

  const META_ENTRY =
`  'framer_update_blog_meta':   (i, c) =>
    execFramerUpdateBlogMeta(i as unknown as Parameters<typeof execFramerUpdateBlogMeta>[0], c),`

  if (!dispatcherContent.includes(META_ENTRY)) {
    console.error('✗  dispatcher.ts: session 1 meta dispatcher entry not found')
    process.exit(1)
  }

  const NEW_ENTRY =
`  'framer_update_blog_meta':   (i, c) =>
    execFramerUpdateBlogMeta(i as unknown as Parameters<typeof execFramerUpdateBlogMeta>[0], c),

  'framer_update_blog_body':   (i, c) =>
    execFramerUpdateBlogBody(i as unknown as Parameters<typeof execFramerUpdateBlogBody>[0], c),`

  dispatcherContent = dispatcherContent.replace(META_ENTRY, NEW_ENTRY)
  fs.writeFileSync(FILES.dispatcher, dispatcherContent, 'utf8')
  console.log(`✅ patched ${path.relative(ROOT, FILES.dispatcher)}`)
}

console.log('')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('Session 2 wire-up complete: framer_update_blog_body')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('')
console.log('1. Verify TypeScript:  npx tsc --noEmit')
console.log('')
console.log('2. Specialist prompt addition — append to SEO skill:')
console.log('   "For body content edits on EXISTING blog posts, file:')
console.log('      propose_action(')
console.log('        toolName: framer_update_blog_body,')
console.log('        toolInput: { slug, newContent },')
console.log('        riskLevel: high')
console.log('      )')
console.log('    newContent is the FULL new HTML body in Framer formattedText.')
console.log('    Use this to refresh stale content, add sections, or insert internal')
console.log('    links (embed <a href="..."> in the HTML). NOT for new posts."')
console.log('')
console.log('3. Deploy:')
console.log('   git add -A && git commit -m "feat: framer_update_blog_body executor (P0 session 2)"')
console.log('   git push origin main')
console.log('')
console.log('4. Test on an existing Tarino blog post — ask agent in Slack to refresh')
console.log('   the body with internal links. Approve. Verify on tarino.au.')
