// src/integrations/framer/cms-write.ts
//
// Shared write infrastructure for Framer CMS blog-item edits. Used by all
// P0 update executors (meta, body, alt-text).
//
// Flow:
//   1. Open Framer session
//   2. Refuse if workspace is dirty (pending changes from elsewhere)
//   3. Find item by slug, capture snapshot of fields about to change
//   4. Update existing item via item.setAttributes({ fieldData })
//   5. publishForAgent: preview → confirm_publish → deploy_to_production
//   6. On any failure after step 4: restore snapshot via second addItems
//
// Updates go through item.setAttributes(). blog.addItems with an existing id
// is documented as upsert but actually leaves the modification in a state
// that fails publishForAgent({ action: 'preview' }) with a missing-version
// Zod error. setAttributes is the proper per-item update API — the item knows
// its own internal version. Confirmed via scripts/probe-setattributes-publish.ts.
// Creates still use blog.addItems but those live in client.ts, not here.

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
    throw new Error(`Blog schema missing required field. Have: ${Object.keys(byName).join(', ')}`)
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
    throw new Error(`No collection named "${BLOG_COLLECTION_NAME}" found in this Framer project.`)
  }
  return blog
}

export async function findBlogItemBySlug(blog: any, slug: string): Promise<any> {
  const items = await blog.getItems()
  const item = items.find((i: { slug: string }) => i.slug === slug)
  if (!item) {
    const sample = items.slice(0, 5).map((i: any) => i.slug).join(', ')
    throw new Error(`Blog item with slug "${slug}" not found. First few slugs: ${sample}${items.length > 5 ? ' …' : ''}`)
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
      throw new Error(`Refusing to edit: ${pending} pending change(s) already in Framer workspace. Clear them in UI (publish or revert), then retry.`)
    }

    // 2. Find item + capture snapshot
    const blog = await findBlogCollection(framer)
    const item = await findBlogItemBySlug(blog, slug)
    const before = captureFieldSnapshots(item, changedFieldIds)

    // 3. Apply update — addItems with existing id = update behaviour
    const mergedFieldData = { ...item.fieldData, ...fieldUpdates }
    await item.setAttributes({
      fieldData: mergedFieldData,
    })

    // 4-6. preview → confirm → deploy, with rollback on failure
    let prodResult: any
    try {
      const preview = await framer.publishForAgent({ action: 'preview' })
      const hash = preview?.confirmationHash ?? preview?.nextAction?.confirmationHash
      if (!hash) {
        throw new Error(`Preview returned no confirmationHash. Shape: ${JSON.stringify(preview ?? null).slice(0, 500)}`)
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
        await item.setAttributes({
          fieldData: restoreFieldData,
        })
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
      productionUrl: productionHost ? `https://${productionHost}/resources/${item.slug}` : `/resources/${item.slug}`,
      deploymentId:  prodResult.deployment?.id,
      hostnames:     prodResult.hostnames,
    }
  })
}
