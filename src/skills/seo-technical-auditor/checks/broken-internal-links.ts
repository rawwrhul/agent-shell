// src/skills/seo-technical-auditor/checks/broken-internal-links.ts

import type { Check, RawFinding } from '../types'
import { makeFindingKey } from './util'

const CHECK_NAME = 'broken_internal_link'

export const brokenInternalLinks: Check = (ctx) => {
  // Build a quick lookup: url → {status, fetchError}.
  const pageStatus = new Map<string, { status: number | null; error: string | null }>()
  for (const p of ctx.pages) {
    pageStatus.set(p.url, { status: p.httpStatus, error: p.fetchError })
    if (p.finalUrl && p.finalUrl !== p.url) {
      pageStatus.set(p.finalUrl, { status: p.httpStatus, error: p.fetchError })
    }
  }

  const findings: RawFinding[] = []
  for (const link of ctx.links) {
    const targetInfo = pageStatus.get(link.targetUrl)
    if (!targetInfo) continue  // target not in our inventory — could be external-but-misclassified; skip
    const broken =
      (targetInfo.status !== null && targetInfo.status >= 400) ||
      targetInfo.error !== null
    if (!broken) continue

    findings.push({
      checkName:   CHECK_NAME,
      findingKey:  makeFindingKey(CHECK_NAME, link.sourceUrl, link.targetUrl),
      targetUrl:   link.sourceUrl,
      relatedUrl:  link.targetUrl,
      severity:    'P1',
      detail: {
        anchor_text:   link.anchorText,
        target_status: targetInfo.status,
        target_error:  targetInfo.error,
        is_nav:        link.isNav,
      },
    })
  }
  return findings
}
