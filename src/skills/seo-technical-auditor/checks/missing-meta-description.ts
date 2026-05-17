// src/skills/seo-technical-auditor/checks/missing-meta-description.ts
//
// Indexable pages missing a meta description. Severity:
//   - P1 if the page is indexable
//   - P2 if it's noindex'd (still worth fixing for social previews but lower)

import type { Check, RawFinding } from '../types'
import { makeFindingKey, isIndexable } from './util'

const CHECK_NAME = 'missing_meta_description'

export const missingMetaDescription: Check = (ctx) => {
  const findings: RawFinding[] = []
  for (const page of ctx.pages) {
    if (page.httpStatus === null || page.httpStatus < 200 || page.httpStatus >= 300) continue
    const empty = page.metaDescription === null || page.metaDescription.trim() === ''
    if (!empty) continue

    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, page.url),
      targetUrl:  page.url,
      relatedUrl: null,
      severity:   isIndexable(page.httpStatus, page.metaRobots) ? 'P1' : 'P2',
      detail: {
        title:       page.title,
        meta_robots: page.metaRobots,
      },
    })
  }
  return findings
}
