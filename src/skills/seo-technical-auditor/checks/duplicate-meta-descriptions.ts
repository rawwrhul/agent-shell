// src/skills/seo-technical-auditor/checks/duplicate-meta-descriptions.ts
//
// Pages sharing the same meta description. Thresholds:
//   - 3-9 pages sharing → P2 (less impactful than duplicate titles; meta
//     descriptions don't directly affect rank, only CTR)
//   - 10+ pages sharing → P1
//
// Same grouping shape as duplicate_titles: one finding per duplicate-group.

import type { Check, RawFinding } from '../types'
import { makeFindingKey, isIndexable } from './util'

const CHECK_NAME = 'duplicate_meta_descriptions'

export const duplicateMetaDescriptions: Check = (ctx) => {
  const groups = new Map<string, string[]>()
  for (const page of ctx.pages) {
    if (!isIndexable(page.httpStatus, page.metaRobots)) continue
    if (!page.metaDescription || !page.metaDescription.trim()) continue
    const key = page.metaDescription.trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(page.url)
  }

  const findings: RawFinding[] = []
  for (const [desc, urls] of groups) {
    if (urls.length < 3) continue
    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, hashLine(desc)),
      targetUrl:  urls[0],
      relatedUrl: null,
      severity:   urls.length >= 10 ? 'P1' : 'P2',
      detail: {
        meta_description: desc,
        page_count:       urls.length,
        affected_urls:    urls.slice(0, 50),
        truncated:        urls.length > 50,
      },
    })
  }
  return findings
}

function hashLine(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16).padStart(8, '0')
}
