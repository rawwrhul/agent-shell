// src/skills/seo-technical-auditor/checks/missing-h1.ts
//
// Indexable pages with zero H1 tags. Severity:
//   - P1 if indexable
//   - P3 otherwise (noindex pages without H1 are unimportant for ranking but
//     might still indicate a broken template)

import type { Check, RawFinding } from '../types'
import { makeFindingKey, isIndexable } from './util'

const CHECK_NAME = 'missing_h1'

export const missingH1: Check = (ctx) => {
  const findings: RawFinding[] = []
  for (const page of ctx.pages) {
    if (page.httpStatus === null || page.httpStatus < 200 || page.httpStatus >= 300) continue
    if (page.h1Count > 0) continue

    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, page.url),
      targetUrl:  page.url,
      relatedUrl: null,
      severity:   isIndexable(page.httpStatus, page.metaRobots) ? 'P1' : 'P3',
      detail: {
        title: page.title,
      },
    })
  }
  return findings
}
