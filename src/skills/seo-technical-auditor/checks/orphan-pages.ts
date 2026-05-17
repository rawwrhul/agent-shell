// src/skills/seo-technical-auditor/checks/orphan-pages.ts
//
// An "orphan" here means an indexable page (200-status, not noindex) with
// zero inbound *content* links (non-nav, non-nofollow). Excludes:
//   - Pages in ctx.excludeFromOrphans (sitemap.xml, robots.txt, etc.)
//   - Pages whose URL is in the seed list (typically homepage)
//
// Relies on ctx.links having `isNav` already updated by the nav heuristic
// pre-pass — so links in non-semantic global navigation (Framer-style)
// are correctly excluded.

import type { Check, RawFinding } from '../types'
import { makeFindingKey, isIndexable, isContentLink } from './util'

const CHECK_NAME = 'orphan_page'

export const orphanPages: Check = (ctx) => {
  // Count content-link inbound per URL.
  const inbound = new Map<string, number>()
  for (const link of ctx.links) {
    if (!isContentLink(link.rel, link.isNav)) continue
    inbound.set(link.targetUrl, (inbound.get(link.targetUrl) ?? 0) + 1)
  }

  const findings: RawFinding[] = []
  for (const page of ctx.pages) {
    if (!isIndexable(page.httpStatus, page.metaRobots)) continue
    if (ctx.excludeFromOrphans.has(page.url)) continue
    const inboundCount = inbound.get(page.url) ?? 0
    // Also check via finalUrl for redirect-collapsed cases.
    const finalInbound = page.finalUrl ? inbound.get(page.finalUrl) ?? 0 : 0
    if (inboundCount + finalInbound > 0) continue

    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, page.url),
      targetUrl:  page.url,
      relatedUrl: null,
      severity:   'P2',
      detail: {
        title:           page.title,
        word_count:      page.wordCount,
        in_sitemap:      ctx.sitemapUrls.has(page.url),
        internal_links_out: page.internalLinksOut,
      },
    })
  }
  return findings
}
