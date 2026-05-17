// src/skills/seo-technical-auditor/nav-heuristic.ts
//
// Improves `isNav` flag on internal links beyond the semantic-HTML
// (<nav>/<header>/<footer>) heuristic the crawler uses. Two reasons this
// matters:
//
//   1. Sites built on Framer/Webflow/Wix often render their nav inside
//      non-semantic divs. The crawler's is_nav flag misses these,
//      producing false orphan reports (e.g. Tarino's /privacy-policy and
//      /terms-and-conditions are linked only from the footer, but the
//      footer isn't a semantic <footer> in Framer's output).
//
//   2. Same logic applies to "linked from every page" content like sticky
//      sidebars, breadcrumb home links, etc.
//
// Rule: any link target appearing on >50% of crawled pages is flagged
// is_nav=true regardless of how the crawler classified it. This is a
// per-audit re-classification — it doesn't mutate the underlying
// seo_internal_links table; we keep the original is_nav as truth from the
// crawler and just compute an "effective" is_nav in memory for the audit.

import type { InternalLink, PageInventory } from './types'

const GLOBAL_LINK_THRESHOLD = 0.5  // 50%

/**
 * Re-flag is_nav on the link set based on the >threshold rule. Returns a
 * new array — does not mutate inputs.
 */
export function applyNavHeuristic(
  links: InternalLink[],
  pages: PageInventory[],
): InternalLink[] {
  if (pages.length === 0) return links

  // Count distinct source pages per target URL.
  const pagesByTarget = new Map<string, Set<string>>()
  for (const l of links) {
    if (!pagesByTarget.has(l.targetUrl)) pagesByTarget.set(l.targetUrl, new Set())
    pagesByTarget.get(l.targetUrl)!.add(l.sourceUrl)
  }

  const threshold = pages.length * GLOBAL_LINK_THRESHOLD
  const globalTargets = new Set<string>()
  for (const [target, sources] of pagesByTarget) {
    if (sources.size > threshold) globalTargets.add(target)
  }

  if (globalTargets.size === 0) return links

  return links.map((l) =>
    globalTargets.has(l.targetUrl) && !l.isNav
      ? { ...l, isNav: true }   // upgrade
      : l,
  )
}
