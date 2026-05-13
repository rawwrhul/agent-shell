// src/integrations/framer/client.ts
//
// Thin wrapper around the `framer-api` npm package (Framer Server API,
// open beta as of March 2026).
//
// Auth model:
//   - API key per project, generated in Framer Site Settings → General → API Keys.
//   - Stored encrypted in integration_credentials.
//   - Project URL stored in tenants.framer_project_url (non-secret).
//
// Usage pattern:
//   const fr = await openFramerSession(tenant)
//   try {
//     const info = await fr.getProjectInfo()
//     ...
//   } finally {
//     await fr.disconnect()
//   }
//
// Or use withFramerSession() which handles disconnect automatically.
//
// VERIFY-AT-DEPLOY: the Framer Server API is in open beta and method names
// may have shifted since this was written. The wrapper isolates all
// `framer-api` package calls to this file — verify against
// https://www.framer.com/developers/server-api-reference and update only here.

import { loadCredential } from '../storage'
import type { TenantConfig } from '../../tenants/types'
import { logger } from '../../logger'

// The framer-api package's exact type surface differs slightly across versions.
// We type the client loosely here and rely on the wrapper to expose a clean
// interface to the rest of the codebase.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FramerClient = any

let _connectFn: ((projectUrl: string, apiKey: string) => Promise<FramerClient>) | null = null

async function getConnect(): Promise<(projectUrl: string, apiKey: string) => Promise<FramerClient>> {
  if (_connectFn) return _connectFn
  // framer-api is an ESM-only package with top-level await. Our build emits
  // CommonJS (tsconfig "module": "CommonJS"), so TypeScript would silently
  // downlevel a plain `await import('framer-api')` into
  // `Promise.resolve(require('framer-api'))` — which throws
  // ERR_REQUIRE_ASYNC_MODULE at runtime because Node 22 can't `require()` an
  // ESM module with top-level await. Hide the import() expression inside
  // `new Function` so TS can't see it and won't transform it. The runtime
  // then evaluates a real native dynamic import.
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

// ── Operation wrappers ──────────────────────────────────────────────────────
//
// Each function here is the ONE place that touches the framer-api surface for a
// given operation. If the method name in the SDK changes, update here only.

export async function getProjectInfo(tenant: TenantConfig): Promise<unknown> {
  return withFramerSession(tenant, async (fr) => fr.getProjectInfo())
}

export async function listPages(tenant: TenantConfig): Promise<unknown[]> {
  return withFramerSession(tenant, async (fr) => {
    // VERIFY: exact method name. Likely `getPages()` or `listPages()`.
    if (typeof fr.getPages === 'function') return fr.getPages()
    if (typeof fr.listPages === 'function') return fr.listPages()
    throw new Error('framer-api: no getPages/listPages method found')
  })
}

export async function getPageSeo(tenant: TenantConfig, pageId: string): Promise<unknown> {
  return withFramerSession(tenant, async (fr) => {
    // VERIFY: exact method name. Likely `getPageMeta(pageId)` or `getSeo(pageId)`.
    if (typeof fr.getPageMeta === 'function') return fr.getPageMeta(pageId)
    if (typeof fr.getSeo === 'function')      return fr.getSeo(pageId)
    if (typeof fr.getPage === 'function')     return fr.getPage(pageId)
    throw new Error('framer-api: no getPageMeta/getSeo/getPage method found')
  })
}

export interface PageSeoUpdate {
  title?:           string
  description?:     string
  ogTitle?:         string
  ogDescription?:   string
  ogImage?:         string
  robots?:          string
}

export async function updatePageSeo(
  tenant: TenantConfig,
  pageId: string,
  update: PageSeoUpdate,
): Promise<unknown> {
  return withFramerSession(tenant, async (fr) => {
    // VERIFY: exact method name. Likely `setPageMeta(pageId, fields)` or
    // `updateSeo(pageId, fields)`. The Plugin API does have node-level SEO
    // setters; the Server API mirrors those.
    if (typeof fr.setPageMeta === 'function')   return fr.setPageMeta(pageId, update)
    if (typeof fr.updatePageSeo === 'function') return fr.updatePageSeo(pageId, update)
    if (typeof fr.updateSeo === 'function')     return fr.updateSeo(pageId, update)
    throw new Error('framer-api: no setPageMeta/updatePageSeo/updateSeo method found')
  })
}

export interface ChangedPaths {
  added:    string[]
  removed:  string[]
  modified: string[]
}

export async function getChangedPaths(tenant: TenantConfig): Promise<ChangedPaths> {
  return withFramerSession(tenant, async (fr) => fr.getChangedPaths()) as Promise<ChangedPaths>
}

export interface PublishResult {
  deployment: { id: string;  [k: string]: unknown }
  hostnames:  string[]
}

export async function publish(tenant: TenantConfig): Promise<PublishResult> {
  return withFramerSession(tenant, async (fr) => fr.publish()) as Promise<PublishResult>
}

export async function deploy(tenant: TenantConfig, deploymentId: string): Promise<unknown> {
  return withFramerSession(tenant, async (fr) => fr.deploy(deploymentId))
}

// CMS operations — verify methods at deploy time.

export interface CmsItem {
  id?:     string
  fields:  Record<string, unknown>
}

export async function createCmsItem(
  tenant:       TenantConfig,
  collectionId: string,
  item:         CmsItem,
): Promise<unknown> {
  return withFramerSession(tenant, async (fr) => {
    if (typeof fr.createCollectionItem === 'function') return fr.createCollectionItem(collectionId, item.fields)
    if (typeof fr.addCmsItem === 'function')           return fr.addCmsItem(collectionId, item.fields)
    throw new Error('framer-api: no createCollectionItem/addCmsItem method found')
  })
}

export async function updateCmsItem(
  tenant:       TenantConfig,
  collectionId: string,
  itemId:       string,
  fields:       Record<string, unknown>,
): Promise<unknown> {
  return withFramerSession(tenant, async (fr) => {
    if (typeof fr.updateCollectionItem === 'function') return fr.updateCollectionItem(collectionId, itemId, fields)
    if (typeof fr.updateCmsItem === 'function')        return fr.updateCmsItem(collectionId, itemId, fields)
    throw new Error('framer-api: no updateCollectionItem/updateCmsItem method found')
  })
}

// ── Draft-mode operations (Task 0.5, 13 May 2026) ─────────────────────────
//
// Wrap Framer's Page Drafts feature (Pro & Enterprise plans). On Basic
// plans where Drafts aren't available, fall back to creating pages as
// live-but-noindex'd — the page exists at its URL but Google won't
// index it. Operator can preview it. On approve, executor removes
// the noindex.

export interface DraftPageInput {
  slug:             string
  title:            string
  metaDescription?: string
  /**
   * Page content as Framer block descriptors. Shape is loose because
   * the framer-api package's block format is in flux; the wrapper passes
   * it through. Typical: [{type:'heading',level:1,text:'...'}, {type:'paragraph',text:'...'}, ...]
   */
  contentBlocks:    Array<Record<string, unknown>>
}

export interface DraftPageResult {
  pageId:      string
  /** URL the operator clicks to preview. Either Framer staging URL or live noindex URL. */
  previewUrl:  string
  /** 'native_draft' = page is in Framer draft state; 'noindex_fallback' = live but hidden. */
  mode:        'native_draft' | 'noindex_fallback'
}

/**
 * Create a new page. Tries native draft first; falls back to live+noindex
 * if the workspace plan doesn't support drafts.
 */
export async function createDraftPage(
  tenant: TenantConfig,
  input:  DraftPageInput,
): Promise<DraftPageResult> {
  return withFramerSession(tenant, async (fr): Promise<DraftPageResult> => {
    const createArgs = {
      slug:            input.slug,
      title:           input.title,
      metaDescription: input.metaDescription,
      content:         input.contentBlocks,
      isDraft:         true,    // Pro/Enterprise: respected; Basic: ignored
    }

    let created: unknown
    try {
      if (typeof fr.createPage === 'function') {
        created = await fr.createPage(createArgs)
      } else if (typeof fr.createWebPage === 'function') {
        created = await fr.createWebPage(createArgs)
      } else if (typeof fr.addPage === 'function') {
        created = await fr.addPage(createArgs)
      } else {
        throw new Error('framer-api: no createPage/createWebPage/addPage method found')
      }
    } catch (err) {
      const msg = String(err).toLowerCase()
      // Detect plan-tier rejection — typically a 403 or "drafts not available" / "upgrade plan".
      if (msg.includes('draft') && (msg.includes('plan') || msg.includes('permission') || msg.includes('upgrade'))) {
        logger.warn('framer_drafts_unavailable_on_plan', {
          tenantId: tenant.tenantId, err: String(err).slice(0, 200),
        })
        return await createPageWithNoindexFallback(tenant, fr, input)
      }
      throw err
    }

    const page = created as { id?: string; pageId?: string; previewUrl?: string; staging_url?: string; url?: string }
    const pageId = page.id ?? page.pageId
    if (!pageId) throw new Error('framer-api: createPage did not return a page ID')

    const previewUrl = await resolvePreviewUrl(fr, pageId, page)
    logger.info('framer_draft_page_created', {
      tenantId: tenant.tenantId, pageId, mode: 'native_draft',
    })
    return { pageId, previewUrl, mode: 'native_draft' }
  })
}

async function createPageWithNoindexFallback(
  tenant: TenantConfig,
  fr:     FramerClient,
  input:  DraftPageInput,
): Promise<DraftPageResult> {
  const createArgs = {
    slug:            input.slug,
    title:           input.title,
    metaDescription: input.metaDescription,
    content:         input.contentBlocks,
    robots:          'noindex, nofollow',  // hide from search engines
  }

  let created: unknown
  if (typeof fr.createPage === 'function') {
    created = await fr.createPage(createArgs)
  } else if (typeof fr.createWebPage === 'function') {
    created = await fr.createWebPage(createArgs)
  } else if (typeof fr.addPage === 'function') {
    created = await fr.addPage(createArgs)
  } else {
    throw new Error('framer-api: no createPage method found for fallback')
  }

  const page = created as { id?: string; pageId?: string; url?: string }
  const pageId = page.id ?? page.pageId
  if (!pageId) throw new Error('framer-api: noindex fallback createPage did not return a page ID')

  const previewUrl = page.url ?? await resolvePreviewUrl(fr, pageId, page)
  logger.info('framer_noindex_fallback_page_created', {
    tenantId: tenant.tenantId, pageId, mode: 'noindex_fallback',
  })
  return { pageId, previewUrl, mode: 'noindex_fallback' }
}

/**
 * Push a draft revision of an existing page. Additions only — never
 * use this to replace or remove existing content.
 */
export interface DraftRevisionInput {
  pageId:    string
  /**
   * Object describing what to add: { afterSection: 'hero', blocks: [...] }
   * or { metaDescriptionAppend: '...' } or { internalLinks: [{anchor, target, placement}] }.
   * Shape is loose; describe placement + content.
   */
  additions: Record<string, unknown>
}

export async function updatePageDraft(
  tenant: TenantConfig,
  input:  DraftRevisionInput,
): Promise<DraftPageResult> {
  return withFramerSession(tenant, async (fr): Promise<DraftPageResult> => {
    const updateArgs = {
      pageId:  input.pageId,
      changes: input.additions,
      asDraft: true,
    }

    let updated: unknown
    try {
      if (typeof fr.updatePage === 'function') {
        updated = await fr.updatePage(updateArgs)
      } else if (typeof fr.editPage === 'function') {
        updated = await fr.editPage(updateArgs)
      } else if (typeof fr.setPageContent === 'function') {
        updated = await fr.setPageContent(input.pageId, input.additions, { asDraft: true })
      } else {
        throw new Error('framer-api: no updatePage/editPage/setPageContent method found')
      }
    } catch (err) {
      const msg = String(err).toLowerCase()
      if (msg.includes('draft') && (msg.includes('plan') || msg.includes('permission'))) {
        logger.warn('framer_draft_revision_unavailable', {
          tenantId: tenant.tenantId, pageId: input.pageId, err: String(err).slice(0, 200),
        })
        // For revisions, fallback is RISKY (live edit bypasses approval).
        // Surface the failure rather than ship to live.
        throw new Error(
          `Draft revisions not available on this workspace plan. Live edits would skip approval, ` +
          `which is unsafe. Operator should upgrade plan or change content manually.`
        )
      }
      throw err
    }

    const result = updated as { id?: string; pageId?: string; previewUrl?: string; staging_url?: string }
    const previewUrl = await resolvePreviewUrl(fr, input.pageId, result)
    return { pageId: input.pageId, previewUrl, mode: 'native_draft' }
  })
}

/**
 * Resolve the preview URL for a page (draft staging URL if available,
 * otherwise live URL).
 */
export async function getPreviewUrl(tenant: TenantConfig, pageId: string): Promise<string> {
  return withFramerSession(tenant, async (fr) => {
    return resolvePreviewUrl(fr, pageId)
  })
}

async function resolvePreviewUrl(
  fr:     FramerClient,
  pageId: string,
  hint?:  { previewUrl?: string; staging_url?: string; url?: string },
): Promise<string> {
  if (hint?.previewUrl) return hint.previewUrl
  if (hint?.staging_url) return hint.staging_url

  if (typeof fr.getPreviewUrl === 'function') return fr.getPreviewUrl(pageId)
  if (typeof fr.getStagingUrl === 'function') return fr.getStagingUrl(pageId)
  if (typeof fr.getPage === 'function') {
    const p = await fr.getPage(pageId) as { previewUrl?: string; url?: string }
    if (p.previewUrl) return p.previewUrl
    if (p.url) return p.url
  }

  if (hint?.url) return hint.url
  throw new Error(`framer-api: could not resolve preview URL for pageId ${pageId}`)
}

/**
 * Read the current body content of a page (not just SEO meta).
 * Used by daily-generation pillars 2 and 3 to see what's already on
 * the page before drafting an addition.
 */
export async function getPageContent(tenant: TenantConfig, slugOrPageId: string): Promise<unknown> {
  return withFramerSession(tenant, async (fr) => {
    if (typeof fr.getPage === 'function') return fr.getPage(slugOrPageId)
    if (typeof fr.getPageContent === 'function') return fr.getPageContent(slugOrPageId)
    throw new Error('framer-api: no getPage/getPageContent method found')
  })
}
