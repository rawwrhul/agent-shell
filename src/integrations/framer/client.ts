// src/integrations/framer/client.ts
//
// Thin wrapper around the `framer-api` npm package.
//
// Auth model:
//   - API key per project, stored encrypted in integration_credentials.
//   - Project URL stored in tenants.framer_project_url (non-secret).
//
// Method surface in this file matches what was verified in
// scripts/framer-manual-tests/ (Phase 0–3, see docs/framer-capabilities.md).
// If a method here doesn't appear in framer-api's .d.ts, it's a bug — verify
// before adding.
//
// Architectural notes:
//   - `framer-api` is ESM with top-level await. Our build is CJS. We hide the
//     dynamic import inside `new Function` so TS doesn't downlevel it (would
//     throw ERR_REQUIRE_ASYNC_MODULE).
//   - `connect(url, token)` returns a remote-API instance with
//     `framer.mode === "api"`. Methods are attached to the instance, not its
//     prototype.

import { loadCredential } from '../storage'
import type { TenantConfig } from '../../tenants/types'
import { logger } from '../../logger'

// The framer-api package's runtime instance has dynamically-attached methods;
// the .d.ts surface is rich but we type loosely here and trust the wrapper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FramerClient = any

const BLOG_COLLECTION_NAME = 'Blog'

let _connectFn: ((projectUrl: string, apiKey: string) => Promise<FramerClient>) | null = null

async function getConnect(): Promise<(projectUrl: string, apiKey: string) => Promise<FramerClient>> {
  if (_connectFn) return _connectFn
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>
  const mod = await dynamicImport('framer-api') as { connect?: (url: string, key: string) => Promise<FramerClient> }
  _connectFn = mod.connect ?? null
  if (!_connectFn) throw new Error('framer-api: connect not found on module')
  return _connectFn
}

export interface FramerSession {
  client:     FramerClient
  disconnect: () => Promise<void>
}

export async function openFramerSession(tenant: TenantConfig): Promise<FramerSession> {
  const projectUrl = tenant.framer_project_url
  if (!projectUrl) {
    throw new Error(`Tenant ${tenant.tenantId}: framer_project_url not set in tenants table`)
  }

  const cred = await loadCredential(tenant.tenantId, 'framer')
  if (!cred) {
    throw new Error(`Tenant ${tenant.tenantId}: no Framer API key stored. Run set-credential script.`)
  }

  const connect = await getConnect()
  const client = await connect(projectUrl, cred.secret)
  logger.info('framer_session_open', { tenantId: tenant.tenantId, projectUrl })

  return {
    client,
    disconnect: async () => {
      try { await client.disconnect() } catch (err) {
        logger.warn('framer_disconnect_error', { tenantId: tenant.tenantId, err: String(err).slice(0, 200) })
      }
    },
  }
}

export async function withFramerSession<T>(
  tenant: TenantConfig,
  fn:     (client: FramerClient) => Promise<T>,
): Promise<T> {
  const session = await openFramerSession(tenant)
  try {
    return await fn(session.client)
  } finally {
    await session.disconnect()
  }
}

// ── Project / publish info reads ────────────────────────────────────────────

export interface ProjectInfo {
  id:           string
  name:         string
  apiVersion1Id?: string
}

export async function getProjectInfo(tenant: TenantConfig): Promise<ProjectInfo> {
  return withFramerSession(tenant, async (fr) => fr.getProjectInfo()) as Promise<ProjectInfo>
}

export interface PublishInfo {
  staging:    { deploymentTime: number;  optimizationStatus: string;  url: string;  currentPageUrl: string }
  production: { deploymentTime: number;  optimizationStatus: string;  url: string;  currentPageUrl: string }
}

export async function getPublishInfo(tenant: TenantConfig): Promise<PublishInfo> {
  return withFramerSession(tenant, async (fr) => fr.getPublishInfo()) as Promise<PublishInfo>
}

export interface ChangedPaths {
  added:    string[]
  removed:  string[]
  modified: string[]
}

export async function getChangedPaths(tenant: TenantConfig): Promise<ChangedPaths> {
  return withFramerSession(tenant, async (fr) => fr.getChangedPaths()) as Promise<ChangedPaths>
}

export async function getPendingChangesCount(tenant: TenantConfig): Promise<number> {
  const c = await getChangedPaths(tenant)
  return (c.added?.length ?? 0) + (c.removed?.length ?? 0) + (c.modified?.length ?? 0)
}

// ── Collection reads ────────────────────────────────────────────────────────

export interface CollectionSummary {
  id:        string
  name:      string
  managedBy: 'user' | 'thisPlugin' | 'anotherPlugin' | string
}

export async function listCollections(tenant: TenantConfig): Promise<CollectionSummary[]> {
  return withFramerSession(tenant, async (fr) => {
    const cs = await fr.getCollections()
    return cs.map((c: { id: string; name: string; managedBy?: string }) => ({
      id: c.id, name: c.name, managedBy: c.managedBy ?? 'unknown',
    }))
  })
}

async function findBlog(fr: FramerClient): Promise<FramerClient> {
  const collections = await fr.getCollections()
  const blog = collections.find((c: { name: string }) => c.name === BLOG_COLLECTION_NAME)
  if (!blog) {
    throw new Error(`No collection named "${BLOG_COLLECTION_NAME}" in this Framer project.`)
  }
  return blog
}

export interface BlogFieldIds {
  titleId:   string
  dateId:    string
  contentId: string
  imageId?:  string   // optional — not all Blog schemas have an Image field
}

async function resolveBlogFieldIds(blog: FramerClient): Promise<BlogFieldIds> {
  const fields = await blog.getFields()
  const byName: Record<string, { id: string }> = {}
  for (const f of fields) byName[f.name] = f
  const titleId   = byName['Title']?.id
  const dateId    = byName['Date']?.id
  const contentId = byName['Content']?.id
  const imageId   = byName['Image']?.id   // optional
  if (!titleId || !dateId || !contentId) {
    throw new Error(`Blog schema missing required field. Have: ${Object.keys(byName).join(', ')}`)
  }
  return { titleId, dateId, contentId, imageId }
}

export interface BlogItemSummary {
  id:    string
  slug:  string
  title: string
  date?: string
}

export async function listBlogItems(tenant: TenantConfig): Promise<BlogItemSummary[]> {
  return withFramerSession(tenant, async (fr) => {
    const blog = await findBlog(fr)
    const { titleId, dateId } = await resolveBlogFieldIds(blog)
    const items = await blog.getItems()
    return items.map((i: { id: string; slug: string; fieldData: Record<string, { value: unknown }> }) => ({
      id:    i.id,
      slug:  i.slug,
      title: String(i.fieldData[titleId]?.value ?? ''),
      date:  String(i.fieldData[dateId]?.value ?? ''),
    }))
  })
}

// ── Draft + preview (write to data model, NOT to production) ────────────────

export interface BlogPostDraft {
  slug:     string
  title:    string
  content:  string             // HTML in Framer's formattedText format
  date?:    string             // ISO 8601; defaults to now
  imageUrl?: string            // external URL — Framer downloads + re-hosts
}

export interface FramerPreviewChange {
  type:   string
  nodeId: string
  name:   string
  status: 'added' | 'modified' | 'removed' | string
}

export interface FramerPreviewResult {
  action:            'preview'
  status:            string
  message:           string
  stagingEnabled:    boolean
  confirmationHash:  string
  errors:            unknown[]
  warnings:          unknown[]
  changes:           FramerPreviewChange[]
  changesCount:      number
  urls:              { production: string }
  nextAction:        { type: string; confirmationHash: string }
}

export interface DraftAndPreviewResult {
  itemId:  string
  post:    BlogPostDraft
  preview: FramerPreviewResult
}

/**
 * Creates the CMS item AND runs the publish preview. Refuses to proceed if
 * pending changes already exist in the workspace (we don't want to commit
 * unrelated edits along with the agent's post).
 *
 * On preview failure, rolls back the created item.
 */
export async function draftAndPreviewBlogPost(
  tenant: TenantConfig,
  post:   BlogPostDraft,
): Promise<DraftAndPreviewResult> {
  return withFramerSession(tenant, async (fr) => {
    // Preflight: no other pending changes
    const cp = await fr.getChangedPaths()
    const pending = (cp.added?.length ?? 0) + (cp.removed?.length ?? 0) + (cp.modified?.length ?? 0)
    if (pending > 0) {
      throw new Error(
        `Refusing to draft: ${pending} pending change(s) already in workspace. Clear them in Framer's UI first.`
      )
    }

    const blog = await findBlog(fr)
    const { titleId, dateId, contentId, imageId } = await resolveBlogFieldIds(blog)

    const fieldData: Record<string, { type: string; value: unknown }> = {
      [titleId]:   { type: 'string',        value: post.title },
      [dateId]:    { type: 'date',          value: post.date ?? new Date().toISOString() },
      [contentId]: { type: 'formattedText', value: post.content },
    }
    if (post.imageUrl && imageId) {
      // Framer accepts an external URL here and downloads + re-hosts on framerusercontent.com.
      fieldData[imageId] = { type: 'image', value: { url: post.imageUrl } }
    }

    await blog.addItems([{ slug: post.slug, fieldData }])

    const items = await blog.getItems()
    const created = items.find((i: { slug: string }) => i.slug === post.slug)
    if (!created) {
      throw new Error(`addItems succeeded but slug "${post.slug}" not found on read-back.`)
    }
    const itemId = created.id

    let preview: FramerPreviewResult
    try {
      preview = await fr.publishForAgent({ action: 'preview' }) as FramerPreviewResult
    } catch (err) {
      // Roll back the just-created item so we don't leave an orphaned draft
      try { await blog.removeItems([itemId]) } catch (rbErr) {
        throw new Error(
          `previewPublish failed AND rollback also failed.\n` +
          `Original: ${String(err).slice(0, 200)}\nRollback: ${String(rbErr).slice(0, 200)}`
        )
      }
      throw err
    }

    return { itemId, post, preview }
  })
}

/**
 * Commit a previously-previewed change set. Production write. Gate every call
 * through the approval flow.
 */
export interface ConfirmPublishResult {
  action:      'confirm_publish'
  status:      string
  deployment?: { id: string }
  hostnames?:  Array<{ hostname: string;  type?: string;  isPrimary?: boolean;  isPublished?: boolean;  deploymentId?: string }>
  [key:        string]: unknown
}

export async function confirmPublish(
  tenant:           TenantConfig,
  confirmationHash: string,
): Promise<ConfirmPublishResult> {
  if (!confirmationHash) throw new Error('confirmPublish requires a confirmationHash')
  return withFramerSession(tenant, async (fr) =>
    fr.publishForAgent({ action: 'confirm_publish', confirmationHash })
  ) as Promise<ConfirmPublishResult>
}

/**
 * Remove a CMS item. Used for rollback on rejection.
 */
export async function removeBlogPost(tenant: TenantConfig, itemId: string): Promise<void> {
  return withFramerSession(tenant, async (fr) => {
    const blog = await findBlog(fr)
    await blog.removeItems([itemId])
  })
}

// ── Atomic create + publish for a new blog post ─────────────────────────────
//
// Combines draftAndPreviewBlogPost (creates CMS item + gets confirmationHash)
// with confirmPublish (commits the publish). Used by the
// framer_create_and_publish_blog_post executor on approval.
//
// On failure between create and publish, the freshly-created item is rolled back
// so we don't leave orphan drafts in the Blog collection.

export interface CreateAndPublishResult {
  itemId:        string
  slug:          string
  productionUrl: string
  publishedAt:   string
}

export async function createAndPublishBlogPost(
  tenant: TenantConfig,
  input:  { slug: string; title: string; content: string; imageUrl?: string },
): Promise<CreateAndPublishResult> {
  const draft = await draftAndPreviewBlogPost(tenant, {
    slug:     input.slug,
    title:    input.title,
    content:  input.content,
    imageUrl: input.imageUrl,
  })
  let publish: ConfirmPublishResult
  try {
    publish = await confirmPublish(tenant, draft.preview.confirmationHash)
  } catch (err) {
    // Best-effort rollback so an interrupted publish doesn't leave cruft behind.
    try { await removeBlogPost(tenant, draft.itemId) } catch { /* swallow */ }
    throw err
  }
  const host = publish.hostnames?.find(h => h.type === 'custom' && h.isPublished)?.hostname
            ?? (() => {
                 try { return new URL(tenant.framer_project_url ?? '').hostname.replace(/^www\./, '') }
                 catch { return undefined }
               })()
  return {
    itemId:        draft.itemId,
    slug:          input.slug,
    productionUrl: host ? `https://${host}/blog/${input.slug}` : `/blog/${input.slug}`,
    publishedAt:   new Date().toISOString(),
  }
}

