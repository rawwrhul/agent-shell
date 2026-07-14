// src/integrations/webflow/client.ts
//
// Thin wrapper around the Webflow Data API v2 (REST — no SDK dependency).
//
// Auth model (mirrors Framer):
//   - Site token per tenant, stored encrypted in integration_credentials
//     under integration='webflow' (loadCredential(tenantId, 'webflow')).
//   - Site id stored in tenants.webflow_site_id (non-secret).
//
// Blog collection + field mapping are resolved dynamically from the
// collection schema (Webflow collections have per-site custom fields; we
// match by slug/displayName patterns) and cached in-module for 10 minutes.
//
// ⚠️ WEBFLOW FOOTGUN (hard-learned): PATCH requests can return 200 and
// silently fail to persist (observed with image alt text). NOTHING in this
// module trusts a write's status code — executors must call the read-back
// helpers and verify. See executor.ts verifyItemField().

import { loadCredential } from '../storage'
import type { TenantConfig } from '../../tenants/types'
import { logger } from '../../logger'

const BASE = 'https://api.webflow.com/v2'
const BLOG_COLLECTION_PATTERNS = /resource|blog|post|article/i

// ── Request core ────────────────────────────────────────────────────────────

export async function webflowRequest(
  tenant: TenantConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path:   string,
  body?:  unknown,
): Promise<unknown> {
  const cred = await loadCredential(tenant.tenantId, 'webflow')
  if (!cred) {
    throw new Error(`Tenant ${tenant.tenantId}: no Webflow site token stored. Run set-credential script with integration='webflow'.`)
  }

  const doFetch = async (): Promise<Response> => fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${cred.secret}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  let res = await doFetch()
  // One retry on rate limit — Webflow is 60 req/min per token.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? 5)
    await new Promise(r => setTimeout(r, Math.min(retryAfter, 30) * 1000))
    res = await doFetch()
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`webflow ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  if (res.status === 204) return {}
  return res.json()
}

function siteIdOf(tenant: TenantConfig): string {
  const id = tenant.webflow_site_id
  if (!id) throw new Error(`Tenant ${tenant.tenantId}: webflow_site_id not set in tenants table`)
  return id
}

// ── Site info ───────────────────────────────────────────────────────────────

export interface WebflowSiteInfo {
  id:              string
  displayName:     string
  customDomainIds: string[]
  customDomains:   string[]
  lastPublished:   string | null
}

const siteCache = new Map<string, { info: WebflowSiteInfo; exp: number }>()
const CACHE_TTL = 10 * 60 * 1000

export async function getSiteInfo(tenant: TenantConfig): Promise<WebflowSiteInfo> {
  const hit = siteCache.get(tenant.tenantId)
  if (hit && hit.exp > Date.now()) return hit.info

  const raw = await webflowRequest(tenant, 'GET', `/sites/${siteIdOf(tenant)}`) as Record<string, unknown>
  const domains = Array.isArray(raw.customDomains) ? raw.customDomains as Array<Record<string, unknown>> : []
  const info: WebflowSiteInfo = {
    id:              String(raw.id ?? siteIdOf(tenant)),
    displayName:     String(raw.displayName ?? raw.shortName ?? ''),
    customDomainIds: domains.map(d => String(d.id)).filter(Boolean),
    customDomains:   domains.map(d => String(d.url)).filter(Boolean),
    lastPublished:   typeof raw.lastPublished === 'string' ? raw.lastPublished : null,
  }
  siteCache.set(tenant.tenantId, { info, exp: Date.now() + CACHE_TTL })
  return info
}

// ── Blog collection + field mapping ─────────────────────────────────────────

export interface BlogFieldMap {
  collectionId:   string
  collectionSlug: string
  /** field slugs inside fieldData */
  titleField:     string    // built-in 'name'
  slugField:      string    // built-in 'slug'
  bodyField:      string | null       // first RichText field
  imageField:     string | null       // first Image field
  metaDescField:  string | null       // PlainText summary/excerpt field
  /** SEO/listing fields — distinct from the summary (learned live: the
   *  blog listing card binds meta-description, not post-summary). */
  seoTitleField:  string | null
  seoDescField:   string | null
}

const fieldMapCache = new Map<string, { map: BlogFieldMap; exp: number }>()

export async function resolveBlogFields(tenant: TenantConfig): Promise<BlogFieldMap> {
  const hit = fieldMapCache.get(tenant.tenantId)
  if (hit && hit.exp > Date.now()) return hit.map

  const listRaw = await webflowRequest(tenant, 'GET', `/sites/${siteIdOf(tenant)}/collections`) as Record<string, unknown>
  const collections = (listRaw.collections ?? []) as Array<Record<string, unknown>>
  if (collections.length === 0) {
    throw new Error(`Tenant ${tenant.tenantId}: Webflow site has no CMS collections`)
  }

  // Prefer a collection whose slug/name looks blog-ish; else the first one.
  const blogCol = collections.find(c =>
    BLOG_COLLECTION_PATTERNS.test(String(c.slug ?? '')) ||
    BLOG_COLLECTION_PATTERNS.test(String(c.displayName ?? '')),
  ) ?? collections[0]
  const collectionId = String(blogCol.id)

  const detail = await webflowRequest(tenant, 'GET', `/collections/${collectionId}`) as Record<string, unknown>
  const fields = (detail.fields ?? []) as Array<Record<string, unknown>>

  const bySlugPattern = (typeMatch: RegExp, slugMatch?: RegExp): string | null => {
    const f = fields.find(f =>
      typeMatch.test(String(f.type ?? '')) &&
      (!slugMatch || slugMatch.test(String(f.slug ?? '')) || slugMatch.test(String(f.displayName ?? ''))),
    )
    return f ? String(f.slug) : null
  }

  const map: BlogFieldMap = {
    collectionId,
    collectionSlug: String(blogCol.slug ?? ''),
    titleField:     'name',
    slugField:      'slug',
    bodyField:      bySlugPattern(/^RichText$/i, /body|content|post/i) ?? bySlugPattern(/^RichText$/i),
    imageField:     bySlugPattern(/^Image$/i, /main|hero|thumb|feature/i) ?? bySlugPattern(/^Image$/i),
    metaDescField:  bySlugPattern(/^PlainText$/i, /summary|excerpt/i) ?? bySlugPattern(/^PlainText$/i, /description/i),
    seoTitleField:  bySlugPattern(/^PlainText$/i, /meta.?title/i),
    seoDescField:   bySlugPattern(/^PlainText$/i, /meta.?desc/i),
  }

  logger.info('webflow_blog_fields_resolved', {
    tenantId: tenant.tenantId, collectionId, collectionSlug: map.collectionSlug,
    bodyField: map.bodyField, imageField: map.imageField, metaDescField: map.metaDescField,
  })
  fieldMapCache.set(tenant.tenantId, { map, exp: Date.now() + CACHE_TTL })
  return map
}

// ── Collection items ────────────────────────────────────────────────────────

export interface WebflowItem {
  id:            string
  isDraft:       boolean
  isArchived:    boolean
  lastPublished: string | null
  fieldData:     Record<string, unknown>
}

function toItem(raw: unknown): WebflowItem {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    id:            String(r.id ?? ''),
    isDraft:       r.isDraft === true,
    isArchived:    r.isArchived === true,
    lastPublished: typeof r.lastPublished === 'string' ? r.lastPublished : null,
    fieldData:     (r.fieldData ?? {}) as Record<string, unknown>,
  }
}

export async function listBlogItems(tenant: TenantConfig, limit = 100): Promise<WebflowItem[]> {
  const map = await resolveBlogFields(tenant)
  const raw = await webflowRequest(tenant, 'GET',
    `/collections/${map.collectionId}/items?limit=${Math.min(limit, 100)}`) as Record<string, unknown>
  return ((raw.items ?? []) as unknown[]).map(toItem)
}

export async function getItemBySlug(tenant: TenantConfig, slug: string): Promise<WebflowItem | null> {
  const clean = slug.trim().replace(/^\/+|\/+$/g, '').split('/').pop() ?? ''
  const items = await listBlogItems(tenant, 100)
  return items.find(i => String(i.fieldData.slug) === clean) ?? null
}

export async function getItemById(tenant: TenantConfig, itemId: string): Promise<WebflowItem> {
  const map = await resolveBlogFields(tenant)
  const raw = await webflowRequest(tenant, 'GET', `/collections/${map.collectionId}/items/${itemId}`)
  return toItem(raw)
}

export async function createDraftItem(
  tenant: TenantConfig, fieldData: Record<string, unknown>,
): Promise<WebflowItem> {
  const map = await resolveBlogFields(tenant)
  const raw = await webflowRequest(tenant, 'POST', `/collections/${map.collectionId}/items`, {
    isDraft: true, isArchived: false, fieldData,
  })
  return toItem(raw)
}

export async function updateItemFields(
  tenant: TenantConfig, itemId: string, fieldData: Record<string, unknown>,
): Promise<WebflowItem> {
  const map = await resolveBlogFields(tenant)
  const raw = await webflowRequest(tenant, 'PATCH', `/collections/${map.collectionId}/items/${itemId}`, {
    fieldData,
  })
  return toItem(raw)
}

export async function deleteItem(tenant: TenantConfig, itemId: string): Promise<void> {
  const map = await resolveBlogFields(tenant)
  await webflowRequest(tenant, 'DELETE', `/collections/${map.collectionId}/items/${itemId}`)
}

/** Publish specific items live (also clears isDraft). */
export async function publishItems(tenant: TenantConfig, itemIds: string[]): Promise<void> {
  const map = await resolveBlogFields(tenant)
  await webflowRequest(tenant, 'POST', `/collections/${map.collectionId}/items/publish`, {
    itemIds,
  })
}

// ── Reference fields (blog template parity) ────────────────────────────────

export interface BlogRefFields {
  /** field slug → MultiReference target collection id */
  multiRefs: Record<string, string>
  /** field slug → Option choices {id, name} */
  options:   Record<string, Array<{ id: string; name: string }>>
}

/** Discover MultiReference + Option fields on the blog collection. */
export async function resolveBlogRefFields(tenant: TenantConfig): Promise<BlogRefFields> {
  const map = await resolveBlogFields(tenant)
  const detail = await webflowRequest(tenant, 'GET', `/collections/${map.collectionId}`) as Record<string, unknown>
  const fields = (detail.fields ?? []) as Array<Record<string, unknown>>
  const out: BlogRefFields = { multiRefs: {}, options: {} }
  for (const f of fields) {
    const slug = String(f.slug ?? '')
    const type = String(f.type ?? '')
    const validations = (f.validations ?? {}) as Record<string, unknown>
    if (type === 'MultiReference' && typeof validations.collectionId === 'string') {
      out.multiRefs[slug] = validations.collectionId
    }
    if (type === 'Option' && Array.isArray(validations.options)) {
      out.options[slug] = (validations.options as Array<Record<string, unknown>>)
        .map(o => ({ id: String(o.id), name: String(o.name) }))
    }
  }
  return out
}

/** List a referenced collection's items as {id, name} (first 100). */
export async function listCollectionItemNames(
  tenant: TenantConfig, collectionId: string,
): Promise<Array<{ id: string; name: string }>> {
  const raw = await webflowRequest(tenant, 'GET', `/collections/${collectionId}/items?limit=100`) as Record<string, unknown>
  return ((raw.items ?? []) as Array<Record<string, unknown>>)
    .map(i => ({
      id:   String(i.id ?? ''),
      name: String(((i.fieldData ?? {}) as Record<string, unknown>).name ?? ''),
    }))
    .filter(x => x.id && x.name)
}

// ── Static pages ────────────────────────────────────────────────────────────

export interface WebflowPage {
  id:    string
  title: string
  slug:  string
  path:  string
}

export async function listPages(tenant: TenantConfig): Promise<WebflowPage[]> {
  const raw = await webflowRequest(tenant, 'GET', `/sites/${siteIdOf(tenant)}/pages?limit=100`) as Record<string, unknown>
  return ((raw.pages ?? []) as Array<Record<string, unknown>>).map(p => ({
    id:    String(p.id ?? ''),
    title: String(p.title ?? ''),
    slug:  String(p.slug ?? ''),
    path:  '/' + String(p.slug ?? '').replace(/^\/+/, ''),
  }))
}

export async function findPageByPath(tenant: TenantConfig, pagePath: string): Promise<WebflowPage | null> {
  const clean = '/' + pagePath.trim().replace(/^\/+|\/+$/g, '')
  const pages = await listPages(tenant)
  return pages.find(p => p.path === clean || p.slug === clean.slice(1)) ?? null
}

export async function getPageMetadata(tenant: TenantConfig, pageId: string): Promise<Record<string, unknown>> {
  return await webflowRequest(tenant, 'GET', `/pages/${pageId}`) as Record<string, unknown>
}

export async function updatePageSeo(
  tenant: TenantConfig, pageId: string, seo: { title?: string; description?: string },
): Promise<void> {
  await webflowRequest(tenant, 'PATCH', `/pages/${pageId}`, { seo })
}

export async function getPageDom(tenant: TenantConfig, pageId: string): Promise<Record<string, unknown>> {
  return await webflowRequest(tenant, 'GET', `/pages/${pageId}/dom?limit=200`) as Record<string, unknown>
}

export async function updatePageDomNodes(
  tenant: TenantConfig, pageId: string, nodes: Array<{ nodeId: string; text: string }>,
): Promise<void> {
  await webflowRequest(tenant, 'POST', `/pages/${pageId}/dom`, { nodes })
}

// ── Site publish ────────────────────────────────────────────────────────────

/** Publish the whole site to its custom domains (static page changes need this). */
export async function publishSite(tenant: TenantConfig): Promise<void> {
  const info = await getSiteInfo(tenant)
  const body = info.customDomainIds.length > 0
    ? { customDomains: info.customDomainIds }
    : { publishToWebflowSubdomain: true }
  await webflowRequest(tenant, 'POST', `/sites/${siteIdOf(tenant)}/publish`, body)
}

// ── URL helpers ─────────────────────────────────────────────────────────────

export function productionUrl(tenant: TenantConfig, path: string): string {
  const domain = (tenant.targetDomain ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `https://${domain}${path.startsWith('/') ? path : `/${path}`}`
}

export function blogPath(tenant: TenantConfig, slug: string): string {
  const prefix = tenant.cmsPathPrefixes?.[0] ?? '/resources/'
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${p}${slug.trim().replace(/^\/+|\/+$/g, '')}`
}
