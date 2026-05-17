// src/skills/seo-technical-auditor/checks/duplicate-titles.ts
//
// Pages sharing the same exact <title>. Thresholds:
//   - 3-9 pages sharing one title → P1
//   - 10+ pages sharing one title → P0 (this is the kind of thing that
//     causes Google to fold pages together in the index — major ranking risk)
//
// Produces ONE finding per duplicate-group (keyed by the title itself), not
// one per page in the group. So 24 pages sharing one title = 1 finding,
// detail listing all 24 affected URLs.
//
// Only considers indexable pages — duplicate titles on noindex pages don't
// affect rankings.

import type { Check, RawFinding } from '../types'
import { makeFindingKey, isIndexable } from './util'

const CHECK_NAME = 'duplicate_titles'

export const duplicateTitles: Check = (ctx) => {
  const groups = new Map<string, string[]>()
  for (const page of ctx.pages) {
    if (!isIndexable(page.httpStatus, page.metaRobots)) continue
    if (!page.title || !page.title.trim()) continue
    const key = page.title.trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(page.url)
  }

  const findings: RawFinding[] = []
  for (const [title, urls] of groups) {
    if (urls.length < 3) continue
    findings.push({
      checkName:  CHECK_NAME,
      findingKey: makeFindingKey(CHECK_NAME, hashLine(title)),
      targetUrl:  urls[0],   // pick the first as the "exemplar"
      relatedUrl: null,
      severity:   urls.length >= 10 ? 'P0' : 'P1',
      detail: {
        title,
        page_count:    urls.length,
        affected_urls: urls.slice(0, 50),  // cap detail to avoid bloating the row
        truncated:     urls.length > 50,
      },
    })
  }
  return findings
}

/** Compact stable hash of a string for use in a finding_key. Avoids embedding
 *  the full title (which could contain :: or other delimiter chars). */
function hashLine(s: string): string {
  // djb2 — small, stable, no node deps. Returns 8-char hex.
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
