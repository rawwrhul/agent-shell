// src/core/crawler/parser.ts
//
// HTML → ParsedPage. Cheerio-based.
//
// Why cheerio and not the regex helpers from analyze_page:
//   - The crawler's value proposition is the internal-link graph. Anything
//     less than ~99% accurate link extraction produces wrong orphan reports
//     downstream, which is actively misleading.
//   - Real-world HTML has multiline <a> tags, weird quoting, attribute
//     ordering surprises, links inside <noscript>, links built from
//     <base href> being relative-rebased, etc. Cheerio handles all of these.
//   - analyze_page stays regex-based for now — single-page checks don't
//     suffer the same compounding error problem, and we don't want to
//     introduce churn there.
//
// What this parser does NOT do:
//   - Execute JS. Pages that build their nav in JS will look orphaned to us.
//     This is a known limitation; document per-tenant.
//   - Follow <meta http-equiv="refresh"> redirects. Fetcher handles HTTP
//     redirects natively; refresh-redirects are rare on real sites.

import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import type { ExtractedLink, ParsedPage } from './types'

/**
 * Reduce a hostname to a comparison key — drop leading `www.`, lowercase.
 * Good enough for "is this link to the same site" detection on single-
 * domain sites. Tenants with multi-subdomain setups (blog.foo.com vs
 * shop.foo.com) configure CrawlConfig.allowedHosts explicitly.
 */
function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

/**
 * Parse the HTML body of a fetched page. Returns a ParsedPage; never throws
 * on malformed HTML (cheerio is permissive). HTTP-level fields (status,
 * contentType, finalUrl) come from the FetchResult — the parser doesn't
 * see the response object.
 */
export function parsePage(args: {
  url:         string
  finalUrl:    string
  httpStatus:  number
  contentType: string | null
  body:        string
}): ParsedPage {
  const { url, finalUrl, httpStatus, contentType, body } = args
  const $ = cheerio.load(body)

  // ── Base URL resolution ────────────────────────────────────────────────
  // <base href> can change how relative URLs resolve. Honour it.
  const baseHrefAttr = $('base[href]').first().attr('href')
  const pageUrl = new URL(finalUrl)
  const baseUrl = baseHrefAttr
    ? safeUrl(baseHrefAttr, finalUrl) ?? pageUrl
    : pageUrl

  // ── Head tags ──────────────────────────────────────────────────────────
  const title = textOrNull($('head > title').first().text())
  const metaDescription = attr($, 'meta[name="description"]', 'content')
  const metaRobots      = attr($, 'meta[name="robots"]',      'content')
  const language        = $('html').attr('lang') ?? null
  const ogImage         = attr($, 'meta[property="og:image"]', 'content')

  const canonicalRaw = attr($, 'link[rel="canonical"]', 'href')
  const canonicalUrl = canonicalRaw
    ? safeUrl(canonicalRaw, baseUrl.href)?.href ?? null
    : null

  // ── Headings ───────────────────────────────────────────────────────────
  const h1s = $('h1').map((_, el) => textOrNull($(el).text())).get().filter(Boolean) as string[]
  const h1Count = h1s.length
  const h1First = h1s[0] ?? null

  // ── JSON-LD @type values ───────────────────────────────────────────────
  const schemaTypes = collectSchemaTypes($)

  // ── Body text + word count + content hash ──────────────────────────────
  // Strip script/style/noscript so they don't pollute the text or hash.
  $('script, style, noscript').remove()
  const bodyText = normalizeWhitespace($('body').text() || $.root().text() || '')
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0
  const contentHash = bodyText
    ? createHash('sha256').update(bodyText).digest('hex')
    : null

  // ── Images ─────────────────────────────────────────────────────────────
  let imageCount = 0
  let imagesWithAlt = 0
  let imagesMissingAlt = 0
  $('img').each((_, el) => {
    imageCount++
    const altRaw = $(el).attr('alt')
    if (altRaw === undefined || altRaw.trim() === '') imagesMissingAlt++
    else imagesWithAlt++
  })

  // ── Links ──────────────────────────────────────────────────────────────
  const links = extractLinks($, baseUrl, pageUrl)
  const internalLinkCount = links.filter((l) => l.isInternal).length
  const externalLinkCount = links.length - internalLinkCount

  return {
    url,
    finalUrl,
    httpStatus,
    contentType,
    contentHash,
    title,
    titleLength:      title?.length ?? 0,
    metaDescription,
    metaDescLength:   metaDescription?.length ?? 0,
    metaRobots,
    canonicalUrl,
    language,
    ogImage,
    h1Count,
    h1First,
    schemaTypes,
    wordCount,
    imageCount,
    imagesWithAlt,
    imagesMissingAlt,
    links,
    internalLinkCount,
    externalLinkCount,
  }
}

// ── Link extraction ──────────────────────────────────────────────────────

function extractLinks(
  $: cheerio.CheerioAPI,
  baseUrl: URL,
  pageUrl: URL,
): ExtractedLink[] {
  const pageRegDomain = siteKey(pageUrl.hostname)

  // Pre-compute which elements live inside <nav>/<header>/<footer> by
  // walking up the tree once. We do it via cheerio's `closest` per anchor,
  // which is O(depth) but fine for typical pages.
  const seen = new Set<string>()  // dedupe by (target, anchor) within one page
  const out: ExtractedLink[] = []
  let positionIndex = 0

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href || !href.trim()) return

    // Skip non-http(s) schemes and pure fragments.
    const cleaned = href.trim()
    if (
      cleaned.startsWith('#') ||
      cleaned.startsWith('mailto:') ||
      cleaned.startsWith('tel:') ||
      cleaned.startsWith('javascript:') ||
      cleaned.startsWith('sms:')
    ) return

    const resolved = safeUrl(cleaned, baseUrl.href)
    if (!resolved) return
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return

    const target = normalizeUrl(resolved)
    const anchorText = normalizeWhitespace($(el).text()).slice(0, 300)
    const rel = $(el).attr('rel') ?? null
    const isNav =
      $(el).closest('nav').length > 0 ||
      $(el).closest('header').length > 0 ||
      $(el).closest('footer').length > 0

    const targetReg = siteKey(resolved.hostname)
    const isInternal = targetReg === pageRegDomain

    const dedupKey = `${target}\u0000${anchorText}`
    if (seen.has(dedupKey)) return
    seen.add(dedupKey)

    out.push({
      target,
      anchorText,
      rel,
      isNav,
      positionIndex: positionIndex++,
      isInternal,
    })
  })

  return out
}

// ── Schema.org type collection ────────────────────────────────────────────

function collectSchemaTypes($: cheerio.CheerioAPI): string[] {
  const types = new Set<string>()

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim()
    if (!raw) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Some sites embed multiple objects without an array wrapper. Try a
      // best-effort recovery for the most common case (JSON-LD-with-trailing-comma).
      try {
        parsed = JSON.parse(raw.replace(/,(\s*[\]}])/g, '$1'))
      } catch {
        return
      }
    }
    addTypesFromNode(parsed, types)
  })

  return Array.from(types).sort()
}

function addTypesFromNode(node: unknown, types: Set<string>): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) addTypesFromNode(item, types)
    return
  }
  const obj = node as Record<string, unknown>
  const t = obj['@type']
  if (typeof t === 'string') types.add(t)
  else if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') types.add(v)

  // @graph is the standard nesting pattern — recurse.
  if (obj['@graph']) addTypesFromNode(obj['@graph'], types)
}

// ── URL helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a URL for storage and dedup:
 *   - drop fragments (#section)
 *   - lowercase hostname
 *   - remove default ports (80/443)
 *   - sort query parameters? — NO, query order can be semantically
 *     meaningful (some sites use order to disambiguate routes). Leave
 *     query strings alone.
 *
 * Trailing slashes are NOT normalized here — '/about' and '/about/' are
 * stored distinctly. They often resolve to the same page via redirect,
 * which we'll catch via final_url anyway. Normalizing here would lose
 * information about which form is linked-to.
 */
export function normalizeUrl(u: URL): string {
  const clone = new URL(u.href)
  clone.hash = ''
  clone.hostname = clone.hostname.toLowerCase()
  if ((clone.protocol === 'http:' && clone.port === '80') ||
      (clone.protocol === 'https:' && clone.port === '443')) {
    clone.port = ''
  }
  return clone.href
}

function safeUrl(input: string, base: string): URL | null {
  try {
    return new URL(input, base)
  } catch {
    return null
  }
}

// ── Text helpers ─────────────────────────────────────────────────────────

function textOrNull(s: string): string | null {
  const t = s.trim()
  return t.length ? t : null
}

function attr($: cheerio.CheerioAPI, selector: string, name: string): string | null {
  const v = $(selector).first().attr(name)
  if (v === undefined) return null
  const t = v.trim()
  return t.length ? t : null
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
