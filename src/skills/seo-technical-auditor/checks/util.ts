// src/skills/seo-technical-auditor/checks/util.ts
//
// Helpers shared by checks. Kept here so each check file stays focused on
// its single rule.

/**
 * Build a stable finding key from check name + parts. Empty/null parts get
 * normalized to '' so the same logical issue produces the same key across audits.
 */
export function makeFindingKey(checkName: string, ...parts: Array<string | null | undefined>): string {
  return [checkName, ...parts.map((p) => p ?? '')].join('::')
}

/** True if the page is indexable (200-status + not noindex). */
export function isIndexable(httpStatus: number | null, metaRobots: string | null): boolean {
  if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) return false
  if (metaRobots && metaRobots.toLowerCase().split(/[,\s]+/).includes('noindex')) return false
  return true
}

/** True if the link is "non-nav" — i.e., a content link worth counting as inbound for orphan detection. */
export function isContentLink(rel: string | null, isNav: boolean): boolean {
  if (isNav) return false
  const relTokens = rel ? rel.toLowerCase().split(/\s+/) : []
  if (relTokens.includes('nofollow')) return false
  return true
}
