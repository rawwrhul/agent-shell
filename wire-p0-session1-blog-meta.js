#!/usr/bin/env node
// wire-p0-session1-blog-meta.js
//
// P0 Session 1: framer_update_blog_meta (single-stage approval write executor).
//
// Adds:
//   - src/integrations/framer/cms-write.ts   (shared blog-item-edit infra)
//   - execFramerUpdateBlogMeta in executor.ts
//   - dispatcher entry for 'framer_update_blog_meta'
//
// Idempotent. Safe to re-run.
//
// Run from repo root:  node wire-p0-session1-blog-meta.js
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const FILES = {
  cmsWrite:   path.join(ROOT, 'src/integrations/framer/cms-write.ts'),
  executor:   path.join(ROOT, 'src/integrations/framer/executor.ts'),
  dispatcher: path.join(ROOT, 'src/execution/dispatcher.ts'),
  client:     path.join(ROOT, 'src/integrations/framer/client.ts'),
}

function assertExists(p, why) {
  if (!fs.existsSync(p)) {
    console.error(`✗  missing required file: ${p} — ${why}`)
    process.exit(1)
  }
}
assertExists(FILES.executor,   'cannot append executor')
assertExists(FILES.dispatcher, 'cannot wire dispatcher')
assertExists(FILES.client,     'cms-write.ts depends on client.ts exports')

// ─────────────────────────────────────────────────────────────────────────────
// 1. cms-write.ts — shared infrastructure (all P0 update executors use this)
// ─────────────────────────────────────────────────────────────────────────────

const CMS_WRITE = `// src/integrations/framer/cms-write.ts
//
// Shared write infrastructure for Framer CMS blog-item edits. Used by all
// P0 update executors (meta, body, alt-text).
//
// Flow:
//   1. Open Framer session
//   2. Refuse if workspace is dirty (pending changes from elsewhere)
//   3. Find item by slug, capture snapshot of fields about to change
//   4. addItems with existing ID = update (per framer-api docs)
//   5. publishForAgent: preview → confirm_publish → deploy_to_production
//   6. On any failure after step 4: restore snapshot via second addItems
//
// addItems is upsert by ID: new ID = create, existing ID = update. Tested in
// scripts/framer-manual-tests/ alongside the create path.

import { logger } from '../../logger'
import { withFramerSession } from './client'
import type { TenantConfig } from '../../tenants/types'

const BLOG_COLLECTION_NAME = 'Blog'

// Description-field name candidates. First match wins. Operators may name
// the field differently — we try the common variants.
const DESCRIPTION_FIELD_CANDIDATES = [
  'Description',
  'Meta Description',
  'description',
  'metaDescription',
  'MetaDescription',
] as const

export interface BlogFieldIdsExtended {
  titleId:        string
  dateId:         string
  contentId:      string
  imageId?:       string
  descriptionId?: string
}

export async function resolveBlogFieldIdsExtended(blog: any): Promise<BlogFieldIdsExtended> {
  const fields = await blog.getFields()
  const byName: Record<string, { id: string; type: string }> = {}
  for (const f of fields) byName[f.name] = f

  const titleId   = byName['Title']?.id
  const dateId    = byName['Date']?.id
  const contentId = byName['Content']?.id
  const imageId   = byName['Image']?.id

  if (!titleId || !dateId || !contentId) {
    throw new Error(\`Blog schema missing required field. Have: \${Object.keys(byName).join(', ')}\`)
  }

  let descriptionId: string | undefined
  for (const candidate of DESCRIPTION_FIELD_CANDIDATES) {
    if (byName[candidate]?.id) {
      descriptionId = byName[candidate].id
      break
    }
  }

  return { titleId, dateId, contentId, imageId, descriptionId }
}

export async function findBlogCollection(framer: any): Promise<any> {
  const cs = await framer.getCollections()
  const blog = cs.find((c: { name: string }) => c.name === BLOG_COLLECTION_NAME)
  if (!blog) {
    throw new Error(\`No collection named "\${BLOG_COLLECTION_NAME}" found in this Framer project.\`)
  }
  return blog
}

export async function findBlogItemBySlug(blog: any, slug: string): Promise<any> {
  const items = await blog.getItems()
  const item = items.find((i: { slug: string }) => i.slug === slug)
  if (!item) {
    const sample = items.slice(0, 5).map((i: any) => i.slug).join(', ')
    throw new Error(\`Blog item with slug "\${slug}" not found. First few slugs: \${sample}\${items.length > 5 ? ' …' : ''}\`)
  }
  return item
}

export interface FieldSnapshot {
  fieldId: string
  value:   unknown
  type:    string
}

export function captureFieldSnapshots(item: any, fieldIds: string[]): FieldSnapshot[] {
  const snapshots: FieldSnapshot[] = []
  for (const fid of fieldIds) {
    const field = item.fieldData?.[fid]
    if (field) {
      snapshots.push({ fieldId: fid, value: field.value, type: field.type })
    }
  }
  return snapshots
}

export interface BlogItemEditOptions {
  slug:            string
  fieldUpdates:    Record<string, { type: string; value: unknown }>
  changedFieldIds: string[]
}

export interface BlogItemEditResult {
  itemId:        string
  slug:          string
  before:        FieldSnapshot[]
  after:         Record<string, unknown>
  productionUrl: string
  deploymentId?: string
  hostnames?:    any
}

function deriveProductionHost(tenant: TenantConfig, hostnames: any[]): string | undefined {
  const fromHostnames = hostnames?.find((h: any) => h.type === 'custom' && h.isPublished)?.hostname
  if (fromHostnames) return fromHostnames
  try {
    const h = new URL(tenant.framer_project_url ?? '').hostname
    return h.startsWith('www.') ? h.slice(4) : h
  } catch {
    return undefined
  }
}

export async function applyBlogItemEdit(
  tenant: TenantConfig,
  opts:   BlogItemEditOptions,
): Promise<BlogItemEditResult> {
  const { slug, fieldUpdates, changedFieldIds } = opts

  return withFramerSession(tenant, async (framer) => {
    // 1. Workspace must be clean
    const cp = await framer.getChangedPaths()
    const pending = (cp.added?.length ?? 0) + (cp.removed?.length ?? 0) + (cp.modified?.length ?? 0)
    if (pending > 0) {
      throw new Error(\`Refusing to edit: \${pending} pending change(s) already in Framer workspace. Clear them in UI (publish or revert), then retry.\`)
    }

    // 2. Find item + capture snapshot
    const blog = await findBlogCollection(framer)
    const item = await findBlogItemBySlug(blog, slug)
    const before = captureFieldSnapshots(item, changedFieldIds)

    // 3. Apply update — addItems with existing id = update behaviour
    const mergedFieldData = { ...item.fieldData, ...fieldUpdates }
    await blog.addItems([{
      id:        item.id,
      slug:      item.slug,
      fieldData: mergedFieldData,
    }])

    // 4-6. preview → confirm → deploy, with rollback on failure
    let prodResult: any
    try {
      const preview = await framer.publishForAgent({ action: 'preview' })
      const hash = preview?.confirmationHash ?? preview?.nextAction?.confirmationHash
      if (!hash) {
        throw new Error(\`Preview returned no confirmationHash. Shape: \${JSON.stringify(preview ?? null).slice(0, 500)}\`)
      }
      await framer.publishForAgent({ action: 'confirm_publish', confirmationHash: hash })
      prodResult = await framer.publishForAgent({ action: 'deploy_to_production' })
    } catch (err) {
      logger.warn('blog_item_edit_rollback_attempt', {
        tenantId: tenant.tenantId,
        slug,
        itemId:   item.id,
        err:      String(err).slice(0, 300),
      })
      // Restore original field values via second addItems
      try {
        const restoreFieldData = { ...item.fieldData }
        for (const snap of before) {
          if (snap.value !== undefined) {
            restoreFieldData[snap.fieldId] = { type: snap.type, value: snap.value }
          }
        }
        await blog.addItems([{
          id:        item.id,
          slug:      item.slug,
          fieldData: restoreFieldData,
        }])
        logger.info('blog_item_edit_rolled_back', { tenantId: tenant.tenantId, slug, itemId: item.id })
      } catch (rbErr) {
        logger.error('blog_item_edit_rollback_failed', {
          tenantId:    tenant.tenantId,
          slug,
          itemId:      item.id,
          originalErr: String(err).slice(0, 300),
          rollbackErr: String(rbErr).slice(0, 300),
        })
      }
      throw err
    }

    const productionHost = deriveProductionHost(tenant, prodResult.hostnames ?? [])
    const after: Record<string, unknown> = {}
    for (const [fid, fv] of Object.entries(fieldUpdates)) {
      after[fid] = fv.value
    }

    return {
      itemId:        item.id,
      slug:          item.slug,
      before,
      after,
      productionUrl: productionHost ? \`https://\${productionHost}/resources/\${item.slug}\` : \`/resources/\${item.slug}\`,
      deploymentId:  prodResult.deployment?.id,
      hostnames:     prodResult.hostnames,
    }
  })
}
`

fs.writeFileSync(FILES.cmsWrite, CMS_WRITE, 'utf8')
console.log(`✅ wrote ${path.relative(ROOT, FILES.cmsWrite)}`)

// ─────────────────────────────────────────────────────────────────────────────
// 2. Patch executor.ts — add imports + execFramerUpdateBlogMeta
// ─────────────────────────────────────────────────────────────────────────────

let executorContent = fs.readFileSync(FILES.executor, 'utf8')

if (executorContent.includes('execFramerUpdateBlogMeta')) {
  console.log(`⚠  executor.ts already has execFramerUpdateBlogMeta — skipping`)
} else {
  const TYPES_IMPORT = `import type { IntegrationContext, ExecutionResult } from '../types'`
  if (!executorContent.includes(TYPES_IMPORT)) {
    console.error(`✗  executor.ts: expected import marker not found: ${TYPES_IMPORT}`)
    process.exit(1)
  }
  const NEW_IMPORTS = `\nimport {\n  applyBlogItemEdit,\n  findBlogCollection,\n  resolveBlogFieldIdsExtended,\n} from './cms-write'`
  executorContent = executorContent.replace(TYPES_IMPORT, TYPES_IMPORT + NEW_IMPORTS)

  const EXECUTOR_BODY = `
// ── framer_update_blog_meta ─────────────────────────────────────────────────
//
// Single-stage approval write executor. Updates the Title and/or Description
// CMS fields on an existing blog item, then publishes + deploys to production.
//
// Agent files propose_action with:
//   toolName:   'framer_update_blog_meta'
//   toolInput:  { slug, newTitle?, newDescription? }
//   riskLevel:  'medium'
//
// On approval, executor:
//   1. Resolves field IDs; errors if Description requested but missing schema
//   2. Updates the requested fields via addItems (id=existing → update)
//   3. preview → confirm_publish → deploy_to_production (atomic)
//   4. Rollback to original values on any post-update failure
//
// Tarino's Blog schema currently has Title/Date/Content/Image only. Until the
// operator adds a Description field to the Blog collection AND updates the
// blog page template to interpolate {{Description}} in Page Settings, this
// executor returns BLOG_SCHEMA_NO_DESCRIPTION_FIELD when newDescription is
// passed. Title-only updates work today.

export interface UpdateBlogMetaInput {
  slug:            string
  newTitle?:       string
  newDescription?: string
}

export async function execFramerUpdateBlogMeta(
  input: UpdateBlogMetaInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug) {
      return { ok: false, summary: 'slug is required', error: 'missing slug' }
    }
    if (!input.newTitle && !input.newDescription) {
      return {
        ok:      false,
        summary: 'At least one of newTitle or newDescription is required',
        error:   'no fields to update',
      }
    }

    // Resolve field IDs (cheap session — schema only) before applying edit
    const fieldIds = await fr.withFramerSession(ctx.tenant, async (framer) => {
      const blog = await findBlogCollection(framer)
      return resolveBlogFieldIdsExtended(blog)
    })

    if (input.newDescription && !fieldIds.descriptionId) {
      return {
        ok:      false,
        summary: 'Cannot update meta description: no Description field exists in the Blog schema yet',
        error:   'BLOG_SCHEMA_NO_DESCRIPTION_FIELD',
        detail:  {
          slug:        input.slug,
          setupNeeded: [
            'Open the Blog collection in Framer designer',
            'Click Settings → add a Plain Text field named "Description"',
            'Open the blog page template → Page Settings → Description field',
            'Set it to {{Description}} so it interpolates the CMS value',
            'Publish the template change',
            'Then retry: framer_update_blog_meta will work for descriptions',
          ],
        },
      }
    }

    const fieldUpdates: Record<string, { type: string; value: unknown }> = {}
    const changedFieldIds: string[] = []
    if (input.newTitle) {
      fieldUpdates[fieldIds.titleId] = { type: 'string', value: input.newTitle }
      changedFieldIds.push(fieldIds.titleId)
    }
    if (input.newDescription && fieldIds.descriptionId) {
      fieldUpdates[fieldIds.descriptionId] = { type: 'string', value: input.newDescription }
      changedFieldIds.push(fieldIds.descriptionId)
    }

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds,
    })

    const updatedFields: string[] = []
    if (input.newTitle)       updatedFields.push('title')
    if (input.newDescription) updatedFields.push('description')

    logger.info('exec_framer_update_blog_meta', {
      tenantId:     ctx.tenant.tenantId,
      taskId:       ctx.taskId,
      approvalId:   ctx.approvalId,
      slug:         input.slug,
      itemId:       editResult.itemId,
      updatedFields,
    })

    return {
      ok:      true,
      summary: \`Updated \${updatedFields.join(' + ')} on \${editResult.productionUrl}\`,
      detail:  {
        slug:          input.slug,
        itemId:        editResult.itemId,
        productionUrl: editResult.productionUrl,
        deploymentId:  editResult.deploymentId,
        before:        editResult.before,
        after:         editResult.after,
        updatedFields,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: \`framer_update_blog_meta failed: \${String(err).slice(0, 160)}\`,
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
// 3. Patch dispatcher.ts — import + map entry
// ─────────────────────────────────────────────────────────────────────────────

let dispatcherContent = fs.readFileSync(FILES.dispatcher, 'utf8')

if (dispatcherContent.includes('execFramerUpdateBlogMeta')) {
  console.log(`⚠  dispatcher.ts already has execFramerUpdateBlogMeta — skipping`)
} else {
  const OLD_IMPORT =
`import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
} from '../integrations/framer/executor'`

  const NEW_IMPORT =
`import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
  execFramerUpdateBlogMeta,
} from '../integrations/framer/executor'`

  if (!dispatcherContent.includes(OLD_IMPORT)) {
    console.error('✗  dispatcher.ts: import block does not match expected shape')
    process.exit(1)
  }
  dispatcherContent = dispatcherContent.replace(OLD_IMPORT, NEW_IMPORT)

  const GSC_MARKER = `  // GSC\n  'gsc_submit_sitemap':`
  if (!dispatcherContent.includes(GSC_MARKER)) {
    console.error('✗  dispatcher.ts: GSC section marker not found')
    process.exit(1)
  }
  const NEW_ENTRY =
`  // P0 single-approval write executors
  'framer_update_blog_meta':   (i, c) =>
    execFramerUpdateBlogMeta(i as unknown as Parameters<typeof execFramerUpdateBlogMeta>[0], c),

`
  dispatcherContent = dispatcherContent.replace(GSC_MARKER, NEW_ENTRY + GSC_MARKER)

  fs.writeFileSync(FILES.dispatcher, dispatcherContent, 'utf8')
  console.log(`✅ patched ${path.relative(ROOT, FILES.dispatcher)}`)
}

console.log('')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('Session 1 wire-up complete.')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('')
console.log('1. Verify TypeScript compiles:')
console.log('   npx tsc --noEmit')
console.log('')
console.log('2. One-time Framer UI setup (enables description updates later):')
console.log('   - Open Tarino Blog collection → Settings → add Plain Text field "Description"')
console.log('   - Open blog page template → Page Settings → Description → set to {{Description}}')
console.log('   - Publish the template change')
console.log('   (Skipping this is fine for now — title updates work without it.)')
console.log('')
console.log('3. Update SEO specialist prompt to use the new tool. Add to skill:')
console.log('   "For meta title/description updates on EXISTING BLOG POSTS, file:')
console.log('      propose_action(')
console.log('        toolName: \"framer_update_blog_meta\",')
console.log('        toolInput: { slug, newTitle?, newDescription? },')
console.log('        riskLevel: \"medium\"')
console.log('      )')
console.log('    Use manual_operator_task ONLY for marketing pages (About/Contact/')
console.log('    Resources) — those page-level metas cannot be edited via Framer API."')
console.log('')
console.log('4. Deploy + test:')
console.log('   git add -A && git commit -m "feat: framer_update_blog_meta executor (P0 session 1)"')
console.log('   git push origin main')
console.log('')
console.log('5. Once deployed, test with an on-demand run — ask agent to propose a')
console.log('   title-only meta update on an existing Tarino blog post.')
