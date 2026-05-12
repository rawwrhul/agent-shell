// src/integrations/dataforseo/client.ts
//
// DataForSEO REST API client.
//
// Auth: HTTP Basic auth with (login, password). Login is your account email,
// password is the API password (separate from your dashboard password, set in
// dataforseo dashboard under API Access).
//
// Stored encrypted in integration_credentials with:
//   secret = '<login>:<password>'    (single-string format chosen for simplicity)
//
// Pricing model: pay-per-request. Keep `limit` low on exploration queries; raise
// only when needed. The agent prompts should reinforce this discipline.
//
// We expose only the read endpoints most useful for autonomous SEO work:
//   - Keywords For Site (what we already rank on)
//   - Ranked Keywords for a domain
//   - SERP for a query (what competitors look like)
//   - Backlinks summary
//   - Keyword search volume + difficulty
//
// Add more endpoints as concrete needs arise. The agent will surface
// "need data not in current tools" if so.

import { loadCredential } from '../storage'
import type { TenantConfig } from '../../tenants/types'

const BASE = 'https://api.dataforseo.com'

async function getAuth(tenant: TenantConfig): Promise<string> {
  const cred = await loadCredential(tenant.tenantId, 'dataforseo')
  if (!cred) {
    throw new Error(`Tenant ${tenant.tenantId}: no DataForSEO credentials stored. Run set-credential script.`)
  }
  // secret is expected as "<login>:<password>"
  return 'Basic ' + Buffer.from(cred.secret).toString('base64')
}

async function call<T>(tenant: TenantConfig, endpoint: string, body: unknown): Promise<T> {
  const auth = await getAuth(tenant)
  const res = await fetch(`${BASE}${endpoint}`, {
    method:  'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`DataForSEO ${endpoint} ${res.status}: ${text.slice(0, 200)}`)
  }
  return await res.json() as T
}

// ── Operations ──────────────────────────────────────────────────────────────

export interface KeywordsForSiteResult {
  keyword:           string
  location_code:     number
  language_code:     string
  search_volume:    number | null
  cpc:               number | null
  competition:       number | null
  competition_level: string | null
  monthly_searches: Array<{ year: number; month: number; search_volume: number }>
}

export async function keywordsForSite(
  tenant:        TenantConfig,
  args: { target: string; locationCode?: number; languageCode?: string; limit?: number },
): Promise<KeywordsForSiteResult[]> {
  type R = { tasks?: Array<{ result?: Array<{ items?: KeywordsForSiteResult[] }> }> }
  const r = await call<R>(tenant, '/v3/dataforseo_labs/google/keywords_for_site/live', [{
    target:        args.target,
    location_code: args.locationCode ?? 2036,  // 2036 = Australia
    language_code: args.languageCode ?? 'en',
    limit:         args.limit ?? 50,
  }])
  return r.tasks?.[0]?.result?.[0]?.items ?? []
}

export interface RankedKeywordsItem {
  keyword_data: {
    keyword:        string
    location_code:  number
    language_code:  string
    keyword_info: {
      search_volume:    number | null
      cpc:               number | null
      competition_level: string | null
    }
  }
  ranked_serp_element: {
    serp_item: {
      rank_group:      number
      rank_absolute:   number
      url:             string
      title:           string
      description:     string
    }
  }
}

export async function rankedKeywords(
  tenant:        TenantConfig,
  args: { target: string; locationCode?: number; languageCode?: string; limit?: number },
): Promise<RankedKeywordsItem[]> {
  type R = { tasks?: Array<{ result?: Array<{ items?: RankedKeywordsItem[] }> }> }
  const r = await call<R>(tenant, '/v3/dataforseo_labs/google/ranked_keywords/live', [{
    target:        args.target,
    location_code: args.locationCode ?? 2036,
    language_code: args.languageCode ?? 'en',
    limit:         args.limit ?? 50,
  }])
  return r.tasks?.[0]?.result?.[0]?.items ?? []
}

export interface SerpItem {
  type:        string
  rank_group:  number
  rank_absolute: number
  domain:      string
  url:         string
  title:       string
  description: string
}

export async function serpOrganicLive(
  tenant:        TenantConfig,
  args: { keyword: string; locationCode?: number; languageCode?: string; depth?: number },
): Promise<SerpItem[]> {
  type R = { tasks?: Array<{ result?: Array<{ items?: SerpItem[] }> }> }
  const r = await call<R>(tenant, '/v3/serp/google/organic/live/advanced', [{
    keyword:       args.keyword,
    location_code: args.locationCode ?? 2036,
    language_code: args.languageCode ?? 'en',
    depth:         args.depth ?? 20,
  }])
  return r.tasks?.[0]?.result?.[0]?.items ?? []
}

export interface BacklinksSummary {
  target:               string
  backlinks:            number
  referring_domains:    number
  referring_main_domains: number
  rank:                 number
  first_seen:           string
  lost_date:            string | null
}

export async function backlinksSummary(
  tenant: TenantConfig,
  args:   { target: string },
): Promise<BacklinksSummary | null> {
  type R = { tasks?: Array<{ result?: BacklinksSummary[] }> }
  const r = await call<R>(tenant, '/v3/backlinks/summary/live', [{
    target:           args.target,
    internal_list_limit: 10,
    include_subdomains: true,
  }])
  return r.tasks?.[0]?.result?.[0] ?? null
}

export interface KeywordOverviewItem {
  keyword:        string
  search_volume:  number | null
  cpc:            number | null
  competition:    number | null
  competition_level: string | null
  keyword_difficulty: number | null
  search_intent_info: { main_intent?: string } | null
}

export async function keywordOverview(
  tenant: TenantConfig,
  args:   { keywords: string[]; locationCode?: number; languageCode?: string },
): Promise<KeywordOverviewItem[]> {
  type R = { tasks?: Array<{ result?: Array<{ items?: KeywordOverviewItem[] }> }> }
  const r = await call<R>(tenant, '/v3/dataforseo_labs/google/keyword_overview/live', [{
    keywords:      args.keywords,
    location_code: args.locationCode ?? 2036,
    language_code: args.languageCode ?? 'en',
  }])
  return r.tasks?.[0]?.result?.[0]?.items ?? []
}
