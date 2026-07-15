// src/integrations/pexels/client.ts
//
// Pexels API wrapper. Used by the pexels_search agent tool to fetch hero
// images for blog posts. Free tier: 200 requests/hour, no attribution legally
// required (appreciated but not enforced).
//
// API key is global (one per Anthropic install, not per tenant) via the
// PEXELS_API_KEY env var. Stock photo APIs don't need per-tenant scoping.

import { logger } from '../../logger'

export interface PexelsPhoto {
  id:           number
  width:        number
  height:       number
  url:          string          // Pexels page URL (for attribution if shown)
  photographer: string
  photographer_url: string
  alt:          string
  src: {
    original:  string
    large2x:   string
    large:     string
    medium:    string
    small:     string
    portrait:  string
    landscape: string
    tiny:      string
  }
}

export interface PexelsSearchResult {
  photos:        PexelsPhoto[]
  total_results: number
  page:          number
  per_page:      number
}

export interface PexelsSearchOptions {
  query:       string
  orientation?: 'landscape' | 'portrait' | 'square'
  per_page?:   number       // default 10, max 80
  page?:       number       // default 1
}

const PEXELS_BASE = 'https://api.pexels.com/v1'

function apiKey(): string {
  const k = process.env.PEXELS_API_KEY
  if (!k) {
    throw new Error(
      'PEXELS_API_KEY env var is not set. Provision it via Cloud Run secrets ' +
      '(e.g. `gcloud run services update cgs-agent-shell --update-secrets=PEXELS_API_KEY=pexels-api-key:latest`).'
    )
  }
  return k
}

export async function searchPexelsPhotos(opts: PexelsSearchOptions): Promise<PexelsSearchResult> {
  const params = new URLSearchParams()
  params.set('query', opts.query)
  if (opts.orientation) params.set('orientation', opts.orientation)
  params.set('per_page', String(opts.per_page ?? 10))
  if (opts.page)        params.set('page', String(opts.page))

  const url = `${PEXELS_BASE}/search?${params.toString()}`
  // 15s abort — 2026-07-15: an unbounded fetch here hung a publish executor
  // for 2 hours after the article had already PASSED its quality gate.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(url, {
      method:  'GET',
      headers: { Authorization: apiKey() },
      signal:  controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Pexels search failed: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
  }
  const data = await res.json() as PexelsSearchResult
  logger.info('pexels_search', {
    query:        opts.query,
    orientation:  opts.orientation,
    returned:     data.photos.length,
    totalResults: data.total_results,
  })
  return data
}
