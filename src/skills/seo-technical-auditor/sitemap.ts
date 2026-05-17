// src/skills/seo-technical-auditor/sitemap.ts
//
// Fetch + parse sitemap.xml for the tenant's domain. Returns the set of
// URLs declared in the sitemap (and any nested sitemaps, one level deep).
//
// Reuses the crawler's polite fetcher so we get the same throttle / timeout
// / robots-respecting behaviour. Returns empty Set on any failure — the
// audit checks treat empty as "skip sitemap_inconsistency" rather than
// produce false-positives.

import { fetchPolite } from '../../core/crawler/fetcher'
import { logger } from '../../logger'

const FETCH_TIMEOUT_MS = 15_000
const USER_AGENT = 'CGSAuditBot/1.0 (+https://cgs.example/bots)'
const MAX_NESTED = 10            // hard cap on nested sitemaps to follow
const MAX_URLS   = 50_000        // sanity cap — most sites are well under

/**
 * Fetch a tenant's sitemap and return the set of URLs declared in it.
 * Follows sitemap-index references one level deep. Returns empty Set on
 * any error — never throws.
 */
export async function fetchSitemapUrls(
  targetDomain: string,
): Promise<Set<string>> {
  const urls = new Set<string>()
  const normalizedDomain = normalizeDomain(targetDomain)
  const sitemapUrl = new URL('/sitemap.xml', normalizedDomain).href

  try {
    const fetched = await fetchPolite(sitemapUrl, {
      timeoutMs:  FETCH_TIMEOUT_MS,
      userAgent:  USER_AGENT,
      throttleMs: 0,
    })
    if (fetched.status !== 200 || !fetched.body) {
      logger.info('audit_sitemap_unavailable', {
        url: sitemapUrl, status: fetched.status, error: fetched.error,
      })
      return urls
    }

    // sitemap.xml is XML but the fetcher only returns body for text/html.
    // We need to make a raw fetch here since most sites serve sitemaps as
    // application/xml or text/xml.
    const xmlBody = await fetchRawText(sitemapUrl)
    if (!xmlBody) return urls

    const { locs, nestedSitemaps } = parseSitemap(xmlBody)
    for (const u of locs) {
      urls.add(u)
      if (urls.size >= MAX_URLS) return urls
    }

    // Follow nested sitemaps (one level deep — don't recurse into a third level).
    let nestedCount = 0
    for (const nestedUrl of nestedSitemaps) {
      if (nestedCount >= MAX_NESTED) break
      nestedCount++
      const nestedBody = await fetchRawText(nestedUrl)
      if (!nestedBody) continue
      const { locs: nestedLocs } = parseSitemap(nestedBody)
      for (const u of nestedLocs) {
        urls.add(u)
        if (urls.size >= MAX_URLS) return urls
      }
    }
  } catch (err) {
    logger.warn('audit_sitemap_fetch_threw', {
      url: sitemapUrl, err: String(err).slice(0, 200),
    })
  }
  return urls
}

/**
 * Raw text fetch — bypasses the crawler fetcher's HTML content-type gating
 * because sitemap.xml is served as XML. Single attempt, generous timeout.
 */
async function fetchRawText(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method:   'GET',
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/xml,text/xml,*/*' },
      signal:   controller.signal,
      redirect: 'follow',
    })
    if (res.status !== 200) {
      logger.info('audit_sitemap_non_200', { url, status: res.status })
      return null
    }
    return await res.text()
  } catch (err) {
    logger.info('audit_sitemap_fetch_error', { url, err: String(err).slice(0, 200) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse sitemap XML. Handles both urlset and sitemapindex documents.
 * No XML parser dep — sitemaps are simple enough for regex extraction
 * (we're matching <loc>...</loc> within either context).
 *
 * Returns {locs} (URL list) and {nestedSitemaps} (URLs from a sitemapindex
 * we should follow).
 */
function parseSitemap(xml: string): { locs: string[]; nestedSitemaps: string[] } {
  const isIndex = /<sitemapindex\b/i.test(xml)
  const locMatches = xml.match(/<loc>\s*([^<]+?)\s*<\/loc>/gi) ?? []
  const allLocs = locMatches
    .map((m) => m.replace(/<\/?loc>/gi, '').trim())
    .filter((u) => /^https?:\/\//i.test(u))

  if (isIndex) {
    return { locs: [], nestedSitemaps: allLocs }
  }
  return { locs: allLocs, nestedSitemaps: [] }
}

function normalizeDomain(td: string): string {
  if (/^https?:\/\//i.test(td)) return td
  return 'https://' + td
}
