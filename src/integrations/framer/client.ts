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
  // Lazy import so test environments without the dep installed still load
  // the rest of the integrations module.
  const mod = await import('framer-api')
  // The package exports `connect` per the docs.
  _connectFn = (mod as { connect: (url: string, key: string) => Promise<FramerClient> }).connect
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
