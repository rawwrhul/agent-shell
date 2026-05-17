// src/skills/seo-technical-auditor/checks/canonical-conflicts.ts
//
// Three sub-issues, all P0 (indexing-risk class):
//   1. canonical_404      — page A's canonical points to URL B, B 404s
//   2. canonical_chain    — page A's canonical points to URL B, B canonicalizes
//                            to URL C (canonical chain — Google may not follow)
//   3. cross_canonical    — page A canonicalizes away from itself to an
//                            unrelated page (could deindex A entirely)
//
// One finding per affected source page, with the sub-issue in `detail.kind`.

import type { Check, RawFinding } from '../types'
import { makeFindingKey, isIndexable } from './util'

const CHECK_NAME = 'canonical_conflict'

export const canonicalConflicts: Check = (ctx) => {
  // Build url → page lookup (by url AND by finalUrl since canonical may
  // reference either form).
  const byUrl = new Map<string, typeof ctx.pages[number]>()
  for (const p of ctx.pages) {
    byUrl.set(p.url, p)
    if (p.finalUrl && p.finalUrl !== p.url) byUrl.set(p.finalUrl, p)
  }

  const findings: RawFinding[] = []
  for (const page of ctx.pages) {
    if (!page.canonicalUrl) continue
    // Skip pages that aren't indexable to begin with — canonical issues on
    // noindex pages aren't ranking-impacting.
    if (!isIndexable(page.httpStatus, page.metaRobots)) continue

    // Self-canonical: page A canonicals to its own URL. That's the healthy case.
    if (page.canonicalUrl === page.url || page.canonicalUrl === page.finalUrl) continue

    const targetPage = byUrl.get(page.canonicalUrl)

    if (!targetPage) {
      // We don't know what the canonical target serves. If we didn't crawl
      // it, we can't tell whether it's broken. Skip silently — don't false-
      // positive on inventory blind spots.
      continue
    }

    // (1) Canonical target 404s
    if (
      targetPage.httpStatus !== null &&
      (targetPage.httpStatus >= 400 || targetPage.fetchError !== null)
    ) {
      findings.push({
        checkName:  CHECK_NAME,
        findingKey: makeFindingKey(CHECK_NAME, page.url, 'target_404'),
        targetUrl:  page.url,
        relatedUrl: page.canonicalUrl,
        severity:   'P0',
        detail: {
          kind:          'canonical_404',
          target_status: targetPage.httpStatus,
          target_error:  targetPage.fetchError,
        },
      })
      continue
    }

    // (2) Canonical chain — target canonicalizes elsewhere
    if (
      targetPage.canonicalUrl &&
      targetPage.canonicalUrl !== targetPage.url &&
      targetPage.canonicalUrl !== targetPage.finalUrl
    ) {
      findings.push({
        checkName:  CHECK_NAME,
        findingKey: makeFindingKey(CHECK_NAME, page.url, 'chain'),
        targetUrl:  page.url,
        relatedUrl: page.canonicalUrl,
        severity:   'P0',
        detail: {
          kind:               'canonical_chain',
          second_hop_canonical: targetPage.canonicalUrl,
        },
      })
      continue
    }

    // (3) Cross-canonical — page A canonicalizes to a different existing page.
    // This is normal if A is a duplicate / paginated variant of B, but if
    // A and B have meaningfully different content/topics, A risks being
    // deindexed. We can't perfectly tell from inventory; flag for review.
    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, page.url, 'cross'),
      targetUrl:  page.url,
      relatedUrl: page.canonicalUrl,
      severity:   'P0',
      detail: {
        kind:                  'cross_canonical',
        page_title:            page.title,
        target_title:          targetPage.title,
        target_status:         targetPage.httpStatus,
        review_needed: true,
      },
    })
  }
  return findings
}
