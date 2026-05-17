// src/skills/seo-technical-auditor/checks/sitemap-inconsistency.ts
//
// Two sub-issues:
//   1. sitemap_url_404  — URL in sitemap returned 4xx/5xx in the crawl. P1.
//   2. missing_from_sitemap — indexable crawled page NOT in sitemap. P2.
//
// Skipped silently if the sitemap couldn't be fetched at all (ctx.sitemapUrls
// is empty). The sitemap fetcher logs that case separately.

import type { Check, RawFinding } from '../types'
import { makeFindingKey, isIndexable } from './util'

const CHECK_NAME = 'sitemap_inconsistency'

export const sitemapInconsistency: Check = (ctx) => {
  if (ctx.sitemapUrls.size === 0) return []

  const findings: RawFinding[] = []

  // (1) URLs in sitemap that 404 in our crawl.
  const byUrl = new Map<string, typeof ctx.pages[number]>()
  for (const p of ctx.pages) {
    byUrl.set(p.url, p)
    if (p.finalUrl && p.finalUrl !== p.url) byUrl.set(p.finalUrl, p)
  }

  for (const sitemapUrl of ctx.sitemapUrls) {
    const page = byUrl.get(sitemapUrl)
    if (!page) continue  // sitemap URL wasn't crawled — could be valid, skip
    const broken =
      (page.httpStatus !== null && page.httpStatus >= 400) ||
      page.fetchError !== null
    if (!broken) continue

    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, sitemapUrl, '404'),
      targetUrl:  sitemapUrl,
      relatedUrl: null,
      severity:   'P1',
      detail: {
        kind:          'sitemap_url_404',
        target_status: page.httpStatus,
        target_error:  page.fetchError,
      },
    })
  }

  // (2) Indexable pages we crawled that aren't in the sitemap.
  for (const page of ctx.pages) {
    if (!isIndexable(page.httpStatus, page.metaRobots)) continue
    if (ctx.sitemapUrls.has(page.url)) continue
    if (page.finalUrl && ctx.sitemapUrls.has(page.finalUrl)) continue

    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, page.url, 'missing'),
      targetUrl:  page.url,
      relatedUrl: null,
      severity:   'P2',
      detail: {
        kind:  'missing_from_sitemap',
        title: page.title,
      },
    })
  }

  return findings
}
