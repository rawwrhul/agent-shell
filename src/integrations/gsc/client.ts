// src/integrations/gsc/client.ts
//
// Google Search Console API client.
//
// Auth model: Application Default Credentials.
// The Cloud Run service runs as a service account. That service account's email
// must be added as a user on each tenant's GSC property (Settings → Users and
// permissions → Add user). Scopes auto-resolved from ADC.
//
// Required APIs enabled on the GCP project: Search Console API
// (searchconsole.googleapis.com).

import { google } from 'googleapis'
import type { TenantConfig } from '../../tenants/types'
import { logger } from '../../logger'

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters',          // read + write (request indexing, submit sitemap)
  'https://www.googleapis.com/auth/webmasters.readonly', // read only
]

let _searchconsole: ReturnType<typeof google.searchconsole> | null = null

async function getClient() {
  if (_searchconsole) return _searchconsole
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES })
  _searchconsole = google.searchconsole({ version: 'v1', auth })
  return _searchconsole
}

function siteUrl(tenant: TenantConfig): string {
  if (!tenant.gsc_site_url) {
    throw new Error(`Tenant ${tenant.tenantId}: gsc_site_url not set in tenants table`)
  }
  return tenant.gsc_site_url
}

// ── Read operations ─────────────────────────────────────────────────────────

export interface SearchAnalyticsRow {
  keys:        string[]    // dimension values in the order requested
  clicks:      number
  impressions: number
  ctr:         number
  position:    number
}

export async function querySearchAnalytics(
  tenant:     TenantConfig,
  options: {
    startDate:  string                       // 'YYYY-MM-DD'
    endDate:    string                       // 'YYYY-MM-DD'
    dimensions: Array<'query'|'page'|'country'|'device'|'searchAppearance'|'date'>
    rowLimit?:  number
    startRow?:  number                       // pagination offset (sync layer)
    type?:      'web'|'image'|'video'|'news'|'discover'|'googleNews'
    dimensionFilterGroups?: unknown
  },
): Promise<SearchAnalyticsRow[]> {
  const sc = await getClient()
  const { data } = await sc.searchanalytics.query({
    siteUrl: siteUrl(tenant),
    requestBody: {
      startDate:    options.startDate,
      endDate:      options.endDate,
      dimensions:   options.dimensions,
      rowLimit:     options.rowLimit ?? 100,
      startRow:     options.startRow ?? 0,
      type:         options.type ?? 'web',
      dimensionFilterGroups: options.dimensionFilterGroups as never,
    },
  })
  return (data.rows ?? []).map(r => ({
    keys:        r.keys ?? [],
    clicks:      r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr:         r.ctr ?? 0,
    position:    r.position ?? 0,
  }))
}

export interface UrlInspection {
  inspectionResultLink?:    string
  indexStatusResult?:        {
    verdict?:               string
    coverageState?:         string
    robotsTxtState?:        string
    indexingState?:         string
    lastCrawlTime?:         string
    pageFetchState?:        string
    googleCanonical?:       string
    userCanonical?:         string
    referringUrls?:         string[]
    crawledAs?:             string
    sitemap?:               string[]
  }
  mobileUsabilityResult?:   unknown
  richResultsResult?:       unknown
  ampResult?:               unknown
}

export async function inspectUrl(tenant: TenantConfig, inspectionUrl: string): Promise<UrlInspection> {
  const sc = await getClient()
  const { data } = await sc.urlInspection.index.inspect({
    requestBody: {
      siteUrl:        siteUrl(tenant),
      inspectionUrl,
      languageCode:   'en-AU',
    },
  })
  // Cast through unknown: googleapis types use `null | undefined` for optional
  // fields, which doesn't structurally match our `undefined`-only interface.
  // The data shape is otherwise compatible.
  return (data.inspectionResult ?? {}) as unknown as UrlInspection
}

export interface SitemapInfo {
  path:           string
  lastSubmitted?: string
  lastDownloaded?:string
  isPending?:     boolean
  isSitemapsIndex?:boolean
  errors?:        number
  warnings?:      number
}

export async function listSitemaps(tenant: TenantConfig): Promise<SitemapInfo[]> {
  const sc = await getClient()
  const { data } = await sc.sitemaps.list({ siteUrl: siteUrl(tenant) })
  return (data.sitemap ?? []).map(s => ({
    path:            s.path ?? '',
    lastSubmitted:   s.lastSubmitted ?? undefined,
    lastDownloaded:  s.lastDownloaded ?? undefined,
    isPending:       s.isPending ?? false,
    isSitemapsIndex: s.isSitemapsIndex ?? false,
    errors:          Number(s.errors ?? 0),
    warnings:        Number(s.warnings ?? 0),
  }))
}

export async function listProperties(): Promise<string[]> {
  const sc = await getClient()
  const { data } = await sc.sites.list({})
  return (data.siteEntry ?? []).map(s => s.siteUrl ?? '').filter(Boolean)
}

// ── Write operations (HITL-gated; called by execution worker) ───────────────

export async function submitSitemap(tenant: TenantConfig, sitemapUrl: string): Promise<void> {
  const sc = await getClient()
  await sc.sitemaps.submit({
    siteUrl:        siteUrl(tenant),
    feedpath:       sitemapUrl,
  })
  logger.info('gsc_sitemap_submitted', { tenantId: tenant.tenantId, sitemapUrl })
}

// Note: GSC's "Request Indexing" via the Indexing API is restricted to
// JobPosting and BroadcastEvent content types. For arbitrary URL re-crawl
// requests, the only option is the Inspect URL → Request Indexing UI flow,
// which is not exposed via API. We expose submitSitemap as the realistic
// "ask Google to re-crawl this content" lever.
//
// If a tenant has JobPosting structured data, the Indexing API can be wired
// in separately — that's a different scope and different API entirely
// (indexing.googleapis.com vs searchconsole.googleapis.com).
