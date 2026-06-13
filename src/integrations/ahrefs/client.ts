// src/integrations/ahrefs/client.ts
//
// Ahrefs API v3 — full access. Auth: Bearer token from the CGS-shared
// `ahrefs_api_key` credential (Secret Manager: cgs-ahrefs-api-key).
//
// Cost model: every paid request costs API units (50-unit minimum, scales
// with rows × fields). Discipline that keeps this cheap:
//   - every call routes through the vendor cache (TTLs per report type)
//   - `select` is always the minimal field set
//   - row limits hard-capped at the tool layer
//
// Recovery trick worth knowing: an invalid `select` makes Ahrefs return an
// error LISTING ALL VALID COLUMNS for that endpoint. Tool errors flow back
// to the agent as strings, so the agent can self-correct field names.
//
// Free test queries: target=ahrefs.com / wordcount.com (or keyword
// 'ahrefs'/'wordcount') cost ZERO units — used by vendor:check.
//
// Not yet wired: Site Audit endpoints (Health Score, Project Issues) —
// they require each site to be configured as an Ahrefs Site Audit project.
// Our own crawler covers technical auditing today; revisit if we want a
// second opinion source.

import { getSharedCredential } from '../../credentials/resolver'
import { logger } from '../../logger'

const BASE = 'https://api.ahrefs.com/v3'

let _key: string | null = null
async function apiKey(): Promise<string> {
  if (_key) return _key
  const cred = await getSharedCredential('ahrefs_api_key')
  if (!cred) throw new Error('Ahrefs API key not configured. Run: npm run setup:cgs (ahrefs_api_key)')
  _key = cred
  return _key
}

export async function ahrefsGet(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const key = await apiKey()
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v))
  }
  const url = `${BASE}${path}?${qs.toString()}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) {
      logger.warn('ahrefs_request_failed', { path, status: res.status, body: body.slice(0, 300) })
      throw new Error(`Ahrefs ${path} → ${res.status}: ${body.slice(0, 400)}`)
    }
    return JSON.parse(body)
  } finally {
    clearTimeout(timer)
  }
}

function today(): string { return new Date().toISOString().slice(0, 10) }

// ── Site Explorer ────────────────────────────────────────────────────────────

export async function domainRating(target: string): Promise<unknown> {
  return ahrefsGet('/site-explorer/domain-rating', { target, date: today() })
}

export async function backlinks(target: string, limit: number, mode: string): Promise<unknown> {
  return ahrefsGet('/site-explorer/all-backlinks', {
    target, mode, limit,
    select: 'url_from,url_to,anchor,domain_rating_source,is_dofollow,first_seen,link_type',
    order_by: 'domain_rating_source:desc',
    aggregation: '1_per_domain',
  })
}

export async function referringDomains(target: string, limit: number): Promise<unknown> {
  return ahrefsGet('/site-explorer/refdomains', {
    target, mode: 'subdomains', limit,
    select: 'domain,domain_rating,dofollow_links,first_seen',
    order_by: 'domain_rating:desc',
  })
}

export async function brokenBacklinks(target: string, limit: number): Promise<unknown> {
  return ahrefsGet('/site-explorer/broken-backlinks', {
    target, mode: 'subdomains', limit,
    select: 'url_from,url_to,anchor,domain_rating_source,is_dofollow',
    order_by: 'domain_rating_source:desc',
    aggregation: '1_per_domain',
  })
}

export async function organicCompetitors(target: string, limit: number, country: string): Promise<unknown> {
  return ahrefsGet('/site-explorer/organic-competitors', {
    target, mode: 'subdomains', limit, country, date: today(),
    select: 'competitor_domain,common_keywords,share',
  })
}

export async function organicKeywords(target: string, mode: string, country: string, limit: number): Promise<unknown> {
  return ahrefsGet('/site-explorer/organic-keywords', {
    target, mode, country, date: today(), limit,
    select: 'keyword,best_position,volume,sum_traffic,best_position_url,keyword_difficulty',
    order_by: 'sum_traffic:desc',
  })
}

export async function topPages(target: string, limit: number, country: string): Promise<unknown> {
  return ahrefsGet('/site-explorer/top-pages', {
    target, mode: 'subdomains', limit, country, date: today(),
    select: 'url,sum_traffic,keywords,top_keyword,top_keyword_best_position',
    order_by: 'sum_traffic:desc',
  })
}

export async function bestByInternalLinks(target: string, limit: number): Promise<unknown> {
  return ahrefsGet('/site-explorer/best-by-internal-links', {
    target, mode: 'subdomains', limit,
    select: 'url,internal_links_count,url_rating,sum_traffic',
    order_by: 'internal_links_count:desc',
  })
}

// ── Keywords Explorer ────────────────────────────────────────────────────────

export async function keywordMetrics(keywords: string, country: string): Promise<unknown> {
  return ahrefsGet('/keywords-explorer/overview', {
    keywords, country,
    select: 'keyword,volume,traffic_potential,difficulty,cpc',
  })
}

export async function keywordIdeas(keyword: string, country: string, limit: number): Promise<unknown> {
  return ahrefsGet('/keywords-explorer/matching-terms', {
    keywords: keyword, country, limit,
    select: 'keyword,volume,difficulty',
    order_by: 'volume:desc',
  })
}

// ── SERP Overview ────────────────────────────────────────────────────────────

export async function serpOverview(keyword: string, country: string, topPositions: number): Promise<unknown> {
  return ahrefsGet('/serp-overview/serp-overview', {
    keyword, country, date: today(), top_positions: topPositions,
    select: 'url,position,title,url_rating,backlinks,refdomains,traffic',
  })
}
