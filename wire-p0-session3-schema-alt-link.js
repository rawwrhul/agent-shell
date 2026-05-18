#!/usr/bin/env node
// wire-p0-session3-schema-alt-link.js
//
// P0 Session 3: ships THREE write executors in one patch.
//
//   1. framer_add_site_schema    — JSON-LD via setCustomCode API (site-wide)
//   2. framer_add_blog_alt_text  — alt text on Image field of existing blog
//   3. framer_add_internal_link  — surgical link insertion in blog body
//
// All three are independent code paths. If one breaks, the others still work.
//
// Idempotent. Safe to re-run.
//
// Run from repo root:  node wire-p0-session3-schema-alt-link.js
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
assertExists(FILES.cmsWrite,   'sessions 1+2 must be applied first')
assertExists(FILES.executor,   '')
assertExists(FILES.dispatcher, '')

const cmsWriteContent = fs.readFileSync(FILES.cmsWrite, 'utf8')
if (!cmsWriteContent.includes('applyBlogItemEdit')) {
  console.error('✗  cms-write.ts missing applyBlogItemEdit — session 1 not applied')
  process.exit(1)
}

const executorRaw = fs.readFileSync(FILES.executor, 'utf8')
if (!executorRaw.includes('execFramerUpdateBlogBody')) {
  console.error('✗  executor.ts missing execFramerUpdateBlogBody — session 2 not applied')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch executor.ts — append three new executors + helper
// ─────────────────────────────────────────────────────────────────────────────

let executorContent = executorRaw

const ALREADY_PRESENT = [
  'execFramerAddSiteSchema',
  'execFramerAddBlogAltText',
  'execFramerAddInternalLink',
].filter(name => executorContent.includes(name))

if (ALREADY_PRESENT.length > 0) {
  console.log(`⚠  executor.ts already has: ${ALREADY_PRESENT.join(', ')} — skipping executor patch`)
} else {
  const EXECUTOR_BODY = `
// ── Internal helper: escapeRegex for marker-based custom code blocks ────────
function escapeRegexForCustomCode(s: string): string {
  return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
}

// ── framer_add_site_schema ──────────────────────────────────────────────────
//
// Injects a JSON-LD schema.org block site-wide via Framer's setCustomCode API
// at headEnd. Schema blocks are wrapped in marker comments so the executor
// can find and replace its own previous output without disturbing other
// custom code the operator has set up manually.
//
// Agent files propose_action with:
//   toolName:   'framer_add_site_schema'
//   toolInput:  { schemaId, jsonLd }
//   riskLevel:  'high'  (Tier A — site-wide change)
//
// schemaId is a stable identifier ('organization', 'website', 'localbusiness')
// so re-running with the same schemaId UPDATES the existing block rather
// than adding a duplicate. The operator can review the full JSON-LD in the
// approval card before approving.
//
// Notes:
//   - jsonLd MUST be valid JSON with @context and @type fields
//   - Each call REPLACES the headEnd custom code with the union of existing
//     blocks + this update; rollback restores the previous headEnd verbatim
//   - For per-page schema, use CMS field interpolation in page template
//     (Pro plan feature — out of scope here)

export interface AddSiteSchemaInput {
  schemaId: string
  jsonLd:   string
}

export async function execFramerAddSiteSchema(
  input: AddSiteSchemaInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.schemaId) return { ok: false, summary: 'schemaId is required', error: 'missing schemaId' }
    if (!input.jsonLd)   return { ok: false, summary: 'jsonLd is required',   error: 'missing jsonLd' }

    let parsed: any
    try {
      parsed = JSON.parse(input.jsonLd)
    } catch (err) {
      return {
        ok:      false,
        summary: 'jsonLd is not valid JSON',
        error:   'JSONLD_PARSE_FAILED',
        detail:  { schemaId: input.schemaId, parseError: String(err).slice(0, 200) },
      }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, summary: 'jsonLd must be a JSON object', error: 'JSONLD_NOT_OBJECT' }
    }
    if (!parsed['@context'] || !parsed['@type']) {
      return {
        ok:      false,
        summary: 'jsonLd missing @context or @type — required for schema.org JSON-LD',
        error:   'JSONLD_MISSING_REQUIRED_FIELDS',
        detail:  { schemaId: input.schemaId, hasContext: !!parsed['@context'], hasType: !!parsed['@type'] },
      }
    }

    const result = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      // Workspace must be clean
      const cp = await framer.getChangedPaths()
      const pending = (cp.added?.length ?? 0) + (cp.removed?.length ?? 0) + (cp.modified?.length ?? 0)
      if (pending > 0) {
        throw new Error(\`Refusing to edit: \${pending} pending change(s) already in Framer workspace.\`)
      }

      // Read current custom code (defensive: support shape variants from SDK)
      let current: any
      try {
        current = await framer.getCustomCode()
      } catch (err) {
        throw new Error(\`getCustomCode failed — the framer-api version may not expose this method: \${String(err).slice(0, 200)}\`)
      }
      // SDK may return { headEnd: { html } } or { headEnd: 'string' } or null
      const currentHeadEnd = ((): string => {
        const he = current?.headEnd
        if (typeof he === 'string') return he
        if (he && typeof he === 'object' && typeof he.html === 'string') return he.html
        return ''
      })()
      const beforeHeadEnd = currentHeadEnd

      // Compose new schema block with marker comments
      const startMarker = \`<!-- agent-schema:\${input.schemaId} -->\`
      const endMarker   = \`<!-- /agent-schema:\${input.schemaId} -->\`
      const newBlock    = \`\${startMarker}\\n<script type="application/ld+json">\${input.jsonLd}</script>\\n\${endMarker}\`

      const blockPattern = new RegExp(
        \`\${escapeRegexForCustomCode(startMarker)}[\\\\s\\\\S]*?\${escapeRegexForCustomCode(endMarker)}\`,
        'i',
      )
      const newHeadEnd = blockPattern.test(currentHeadEnd)
        ? currentHeadEnd.replace(blockPattern, newBlock)
        : (currentHeadEnd ? \`\${currentHeadEnd}\\n\${newBlock}\` : newBlock)

      // Write + publish + deploy, with rollback on failure
      let prodResult: any
      try {
        await framer.setCustomCode({ html: newHeadEnd, location: 'headEnd' })
        const preview = await framer.publishForAgent({ action: 'preview' })
        const hash = preview?.confirmationHash ?? preview?.nextAction?.confirmationHash
        if (!hash) {
          throw new Error(\`Preview returned no confirmationHash. Shape: \${JSON.stringify(preview ?? null).slice(0, 500)}\`)
        }
        await framer.publishForAgent({ action: 'confirm_publish', confirmationHash: hash })
        prodResult = await framer.publishForAgent({ action: 'deploy_to_production' })
      } catch (err) {
        logger.warn('schema_rollback_attempt', {
          tenantId: ctx.tenant.tenantId,
          schemaId: input.schemaId,
          err:      String(err).slice(0, 300),
        })
        try {
          await framer.setCustomCode({ html: beforeHeadEnd, location: 'headEnd' })
          logger.info('schema_rolled_back', { tenantId: ctx.tenant.tenantId, schemaId: input.schemaId })
        } catch (rbErr) {
          logger.error('schema_rollback_failed', {
            tenantId:    ctx.tenant.tenantId,
            schemaId:    input.schemaId,
            originalErr: String(err).slice(0, 300),
            rollbackErr: String(rbErr).slice(0, 300),
          })
        }
        throw err
      }

      return { beforeHeadEnd, newHeadEnd, prodResult }
    })

    logger.info('exec_framer_add_site_schema', {
      tenantId:     ctx.tenant.tenantId,
      taskId:       ctx.taskId,
      approvalId:   ctx.approvalId,
      schemaId:     input.schemaId,
      schemaType:   parsed['@type'],
      jsonLdLength: input.jsonLd.length,
    })

    return {
      ok:      true,
      summary: \`Injected \${parsed['@type']} JSON-LD (\${input.schemaId}) site-wide\`,
      detail:  {
        schemaId:     input.schemaId,
        schemaType:   parsed['@type'],
        jsonLdLength: input.jsonLd.length,
        deploymentId: result.prodResult.deployment?.id,
        beforeBytes:  result.beforeHeadEnd.length,
        afterBytes:   result.newHeadEnd.length,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: \`framer_add_site_schema failed: \${String(err).slice(0, 160)}\`,
      error:   String(err).slice(0, 500),
    }
  }
}

// ── framer_add_blog_alt_text ────────────────────────────────────────────────
//
// Adds alt text to the Image field of an existing blog post. Reads the
// current image field value to detect its shape (string URL vs object
// with url/altText), then writes back with altText set.
//
// Agent files propose_action with:
//   toolName:   'framer_add_blog_alt_text'
//   toolInput:  { slug, newAltText }
//   riskLevel:  'low'  (alt text is pure accessibility/SEO win)
//
// If the Blog schema has no Image field, returns BLOG_SCHEMA_NO_IMAGE_FIELD.
// If the post has no image set yet, returns NO_IMAGE_TO_ANNOTATE.
// Image-field shape is detected at runtime — logs the shape for future
// reference so we can simplify once we've seen real data.

export interface AddBlogAltTextInput {
  slug:       string
  newAltText: string
}

export async function execFramerAddBlogAltText(
  input: AddBlogAltTextInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug)       return { ok: false, summary: 'slug is required',       error: 'missing slug' }
    if (!input.newAltText) return { ok: false, summary: 'newAltText is required', error: 'missing newAltText' }

    const { fieldIds, currentImageValue } = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      const blog = await findBlogCollection(framer)
      const fids = await resolveBlogFieldIdsExtended(blog)
      if (!fids.imageId) return { fieldIds: fids, currentImageValue: undefined }
      const items = await blog.getItems()
      const item = items.find((i: { slug: string }) => i.slug === input.slug)
      if (!item) throw new Error(\`Blog item with slug "\${input.slug}" not found\`)
      return { fieldIds: fids, currentImageValue: item.fieldData?.[fids.imageId]?.value }
    })

    if (!fieldIds.imageId) {
      return {
        ok:      false,
        summary: 'Blog schema has no Image field — alt text cannot be set',
        error:   'BLOG_SCHEMA_NO_IMAGE_FIELD',
      }
    }
    if (currentImageValue === undefined || currentImageValue === null) {
      return {
        ok:      false,
        summary: 'Blog post has no image set — add an image first, then add alt text',
        error:   'NO_IMAGE_TO_ANNOTATE',
        detail:  { slug: input.slug },
      }
    }

    // Detect shape and construct updated value preserving original fields
    let updatedValue: unknown
    let detectedShape: string
    if (typeof currentImageValue === 'string') {
      detectedShape = 'url-string'
      updatedValue = { url: currentImageValue, altText: input.newAltText }
    } else if (typeof currentImageValue === 'object' && currentImageValue !== null) {
      detectedShape = 'object'
      updatedValue = { ...(currentImageValue as Record<string, unknown>), altText: input.newAltText }
    } else {
      return {
        ok:      false,
        summary: \`Unexpected image field shape: \${typeof currentImageValue}\`,
        error:   'IMAGE_FIELD_SHAPE_UNKNOWN',
        detail:  { currentValueType: typeof currentImageValue, sample: String(currentImageValue).slice(0, 200) },
      }
    }

    logger.info('alt_text_shape_detected', {
      tenantId:           ctx.tenant.tenantId,
      slug:               input.slug,
      shape:              detectedShape,
      currentValueSample: JSON.stringify(currentImageValue).slice(0, 200),
    })

    const fieldUpdates = {
      [fieldIds.imageId]: { type: 'image', value: updatedValue },
    }

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds: [fieldIds.imageId],
    })

    logger.info('exec_framer_add_blog_alt_text', {
      tenantId:      ctx.tenant.tenantId,
      taskId:        ctx.taskId,
      approvalId:    ctx.approvalId,
      slug:          input.slug,
      itemId:        editResult.itemId,
      altTextLength: input.newAltText.length,
      detectedShape,
    })

    return {
      ok:      true,
      summary: \`Added alt text to image on \${editResult.productionUrl}\`,
      detail:  {
        slug:          input.slug,
        itemId:        editResult.itemId,
        productionUrl: editResult.productionUrl,
        deploymentId:  editResult.deploymentId,
        altText:       input.newAltText,
        detectedShape,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: \`framer_add_blog_alt_text failed: \${String(err).slice(0, 160)}\`,
      error:   String(err).slice(0, 500),
    }
  }
}

// ── framer_add_internal_link ────────────────────────────────────────────────
//
// Surgical internal-link insertion in an existing blog post body. Wraps the
// first occurrence of sourceText (outside existing <a> tags) in an anchor
// pointing to targetUrl. Refuses if a link to targetUrl already exists in
// the body.
//
// Agent files propose_action with:
//   toolName:   'framer_add_internal_link'
//   toolInput:  { slug, sourceText, targetUrl }
//   riskLevel:  'medium'
//
// For BULK or sweeping body rewrites, use framer_update_blog_body instead —
// this tool is for one-link-at-a-time additions.

export interface AddInternalLinkInput {
  slug:       string
  sourceText: string
  targetUrl:  string
}

function escapeRegexLink(s: string): string {
  return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
}

function insertInternalLink(html: string, sourceText: string, targetUrl: string): string | null {
  // Split on <a>...</a> blocks. We only insert into NON-anchor parts so we
  // never nest anchors or replace text inside existing links.
  const parts = html.split(/(<a\\b[^>]*>[\\s\\S]*?<\\/a>)/gi)
  for (let i = 0; i < parts.length; i++) {
    if (/^<a\\b/i.test(parts[i])) continue
    const idx = parts[i].indexOf(sourceText)
    if (idx !== -1) {
      const safeUrl = targetUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      parts[i] = parts[i].slice(0, idx) +
                 \`<a href="\${safeUrl}">\${sourceText}</a>\` +
                 parts[i].slice(idx + sourceText.length)
      return parts.join('')
    }
  }
  return null
}

export async function execFramerAddInternalLink(
  input: AddInternalLinkInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug)       return { ok: false, summary: 'slug is required',       error: 'missing slug' }
    if (!input.sourceText) return { ok: false, summary: 'sourceText is required', error: 'missing sourceText' }
    if (!input.targetUrl)  return { ok: false, summary: 'targetUrl is required',  error: 'missing targetUrl' }

    const { fieldIds, currentContent } = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      const blog = await findBlogCollection(framer)
      const fids = await resolveBlogFieldIdsExtended(blog)
      const items = await blog.getItems()
      const item = items.find((i: { slug: string }) => i.slug === input.slug)
      if (!item) throw new Error(\`Blog item with slug "\${input.slug}" not found\`)
      return {
        fieldIds:       fids,
        currentContent: (item.fieldData?.[fids.contentId]?.value ?? '') as string,
      }
    })

    // Refuse if already linked to that URL
    const escapedUrl = escapeRegexLink(input.targetUrl)
    const existingPattern = new RegExp(\`<a[^>]*href=["']\${escapedUrl}["']\`, 'i')
    if (existingPattern.test(currentContent)) {
      return {
        ok:      false,
        summary: \`A link to \${input.targetUrl} already exists in this post\`,
        error:   'LINK_ALREADY_EXISTS',
        detail:  { slug: input.slug, targetUrl: input.targetUrl },
      }
    }

    const newContent = insertInternalLink(currentContent, input.sourceText, input.targetUrl)
    if (!newContent) {
      return {
        ok:      false,
        summary: \`Source text "\${input.sourceText.slice(0, 60)}" not found in body (outside existing links)\`,
        error:   'SOURCE_TEXT_NOT_FOUND',
        detail:  { slug: input.slug, sourceText: input.sourceText },
      }
    }

    const fieldUpdates = {
      [fieldIds.contentId]: { type: 'formattedText', value: newContent },
    }

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds: [fieldIds.contentId],
    })

    logger.info('exec_framer_add_internal_link', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      slug:       input.slug,
      itemId:     editResult.itemId,
      sourceText: input.sourceText.slice(0, 100),
      targetUrl:  input.targetUrl,
    })

    return {
      ok:      true,
      summary: \`Linked "\${input.sourceText.slice(0, 60)}" → \${input.targetUrl} on \${editResult.productionUrl}\`,
      detail:  {
        slug:          input.slug,
        itemId:        editResult.itemId,
        productionUrl: editResult.productionUrl,
        deploymentId:  editResult.deploymentId,
        sourceText:    input.sourceText,
        targetUrl:     input.targetUrl,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: \`framer_add_internal_link failed: \${String(err).slice(0, 160)}\`,
      error:   String(err).slice(0, 500),
    }
  }
}
`

  executorContent = executorContent.trimEnd() + '\n' + EXECUTOR_BODY
  fs.writeFileSync(FILES.executor, executorContent, 'utf8')
  console.log(`✅ patched ${path.relative(ROOT, FILES.executor)} (3 new executors)`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch dispatcher.ts — add imports + 3 map entries
// ─────────────────────────────────────────────────────────────────────────────

let dispatcherContent = fs.readFileSync(FILES.dispatcher, 'utf8')

const DISPATCHER_ALREADY = [
  'execFramerAddSiteSchema',
  'execFramerAddBlogAltText',
  'execFramerAddInternalLink',
].filter(name => dispatcherContent.includes(name))

if (DISPATCHER_ALREADY.length > 0) {
  console.log(`⚠  dispatcher.ts already has: ${DISPATCHER_ALREADY.join(', ')} — skipping`)
} else {
  const OLD_IMPORT =
`import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
  execFramerUpdateBlogMeta,
  execFramerUpdateBlogBody,
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
  execFramerAddSiteSchema,
  execFramerAddBlogAltText,
  execFramerAddInternalLink,
} from '../integrations/framer/executor'`

  if (!dispatcherContent.includes(OLD_IMPORT)) {
    console.error('✗  dispatcher.ts: import block does not match — session 2 not applied?')
    process.exit(1)
  }
  dispatcherContent = dispatcherContent.replace(OLD_IMPORT, NEW_IMPORT)

  const BODY_ENTRY =
`  'framer_update_blog_body':   (i, c) =>
    execFramerUpdateBlogBody(i as unknown as Parameters<typeof execFramerUpdateBlogBody>[0], c),`

  if (!dispatcherContent.includes(BODY_ENTRY)) {
    console.error('✗  dispatcher.ts: session 2 body entry not found')
    process.exit(1)
  }

  const NEW_ENTRIES =
`  'framer_update_blog_body':   (i, c) =>
    execFramerUpdateBlogBody(i as unknown as Parameters<typeof execFramerUpdateBlogBody>[0], c),

  'framer_add_site_schema':    (i, c) =>
    execFramerAddSiteSchema(i as unknown as Parameters<typeof execFramerAddSiteSchema>[0], c),

  'framer_add_blog_alt_text':  (i, c) =>
    execFramerAddBlogAltText(i as unknown as Parameters<typeof execFramerAddBlogAltText>[0], c),

  'framer_add_internal_link':  (i, c) =>
    execFramerAddInternalLink(i as unknown as Parameters<typeof execFramerAddInternalLink>[0], c),`

  dispatcherContent = dispatcherContent.replace(BODY_ENTRY, NEW_ENTRIES)
  fs.writeFileSync(FILES.dispatcher, dispatcherContent, 'utf8')
  console.log(`✅ patched ${path.relative(ROOT, FILES.dispatcher)} (3 dispatcher entries)`)
}

console.log('')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('Session 3 wire-up complete: schema + alt text + internal link')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('')
console.log('1. Verify TypeScript:  npx tsc --noEmit')
console.log('')
console.log('2. Specialist prompt addition — append to SEO skill:')
console.log('')
console.log('   "Three new tools for SEO write actions:')
console.log('')
console.log('   propose_action(toolName=framer_add_site_schema,')
console.log('     toolInput={schemaId, jsonLd}, riskLevel=high)')
console.log('   — Site-wide JSON-LD. schemaId is stable identifier so re-runs')
console.log('     UPDATE rather than duplicate. Validate JSON parses + has')
console.log('     @context and @type before proposing.')
console.log('')
console.log('   propose_action(toolName=framer_add_blog_alt_text,')
console.log('     toolInput={slug, newAltText}, riskLevel=low)')
console.log('   — Alt text on blog post Image field. Low-risk a11y/SEO win.')
console.log('')
console.log('   propose_action(toolName=framer_add_internal_link,')
console.log('     toolInput={slug, sourceText, targetUrl}, riskLevel=medium)')
console.log('   — Wraps first matching sourceText in body in an <a> to targetUrl.')
console.log('     For BULK link insertions or body refresh, use framer_update_blog_body."')
console.log('')
console.log('3. Deploy:')
console.log('   git add -A && git commit -m "feat: schema + alt-text + internal-link executors (P0 session 3)"')
console.log('   git push origin main')
console.log('')
console.log('4. Test each tool independently after deploy:')
console.log('')
console.log('   a) SCHEMA — ask agent to propose Organization schema for Tarino.')
console.log('      After approval, view-source on tarino.au and search for')
console.log('      "application/ld+json" — should find the new block.')
console.log('')
console.log('   b) ALT TEXT — pick an existing blog post with an image, ask agent')
console.log('      to propose alt text. Approve. View-source on the post, find')
console.log('      the img tag, verify alt attribute is set.')
console.log('      The "detectedShape" field in execution_jobs.result tells us')
console.log('      whether Framer returned a url-string or object — useful for')
console.log('      future simplification of this executor.')
console.log('')
console.log('   c) INTERNAL LINK — pick an existing post, ask agent to link a')
console.log('      specific phrase to another resource. After approval, view-source')
console.log('      on the post, find the new <a href="..."> wrapping the phrase.')
console.log('')
console.log('5. Note on schema executor: framer.getCustomCode/setCustomCode are')
console.log('   from the Plugin API reference. If the framer-api package on our')
console.log('   version does not expose these, the schema executor returns a')
console.log('   clear error mentioning "the framer-api version may not expose')
console.log('   this method" — that diagnostic tells us to upgrade the package.')
