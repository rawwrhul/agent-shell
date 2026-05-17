// src/skills/seo-technical-auditor/checks/multiple-h1.ts
//
// Pages with more than one H1. P3 (cosmetic — modern SEO doesn't penalize
// this strictly, but it usually indicates template misuse worth flagging).

import type { Check, RawFinding } from '../types'
import { makeFindingKey } from './util'

const CHECK_NAME = 'multiple_h1'

export const multipleH1: Check = (ctx) => {
  const findings: RawFinding[] = []
  for (const page of ctx.pages) {
    if (page.h1Count <= 1) continue

    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, page.url),
      targetUrl:  page.url,
      relatedUrl: null,
      severity:   'P3',
      detail: {
        title:    page.title,
        h1_count: page.h1Count,
        h1_first: page.h1First,
      },
    })
  }
  return findings
}
