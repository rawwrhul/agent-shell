// src/skills/seo-discovery/cluster-fit.ts
//
// Phase 2, unit 3: resolves the cluster-fit weight for a discovery candidate.
//
// The strategy doc's portfolio is the keyword->cluster bridge: each portfolio
// cluster carries targetKeywords + a disposition. A candidate keyword that
// falls in an `attack`/`grow` cluster is worth more (it compounds toward the
// strategic goal); one in `ignore` is suppressed but not zeroed (explore/
// exploit: a big enough opportunity in an ignored cluster can still surface).
// A keyword absent from the portfolio is neutral (1.0), NOT ignored.
//
// Matching is whole-phrase containment, not exact equality: a real GSC query
// like "hire offshore accountant australia" inherits the disposition of the
// portfolio phrase "offshore accountant" it contains. The longest matching
// portfolio phrase wins (most specific = best topical signal). Exact equality
// is just the degenerate case of containment. This is what lets the strategy
// actually steer scores; exact-only matching left almost everything neutral.
//
// This is the single point where the LLM-authored strategy parameterises the
// otherwise-deterministic EV score, via the cluster_fit term.

import { logger } from '../../logger'
import { getLatestStrategy } from '../../core/strategy/store'
import { ClusterDisposition, StrategyCore } from '../../core/strategy/types'

export const DISPOSITION_WEIGHTS: Readonly<Record<ClusterDisposition, number>> = {
  attack: 1.30,
  grow:   1.20,
  defend: 1.10,
  seed:   1.00,
  ignore: 0.25,
}

/** Neutral weight for keywords not present in any portfolio cluster. */
export const NEUTRAL_FIT = 1.0

export function weightForDisposition(d: ClusterDisposition | null): number {
  if (d === null) return NEUTRAL_FIT
  return DISPOSITION_WEIGHTS[d] ?? NEUTRAL_FIT
}

export interface ClusterFitResolver {
  /** Cluster-fit weight for a keyword (undefined/unknown -> neutral 1.0). */
  fit(keyword?: string | null): number
  /** The disposition a keyword maps to, or null if not in the portfolio. */
  dispositionFor(keyword?: string | null): ClusterDisposition | null
}

interface PortfolioEntry { phrase: string; disposition: ClusterDisposition; len: number }

/** Whole-phrase, space-delimited containment: is `needle` a phrase within `hay`? */
function phraseContains(hay: string, needle: string): boolean {
  if (!needle) return false
  return (' ' + hay + ' ').includes(' ' + needle + ' ')
}

/** Pure: build a resolver from a strategy core (no I/O). Unit-testable. */
export function buildResolverFromCore(core: StrategyCore | null): ClusterFitResolver {
  const entries: PortfolioEntry[] = []
  if (core) {
    for (const cluster of core.portfolio) {
      for (const kw of cluster.targetKeywords) {
        const phrase = kw.trim().toLowerCase()
        if (phrase) entries.push({ phrase, disposition: cluster.disposition, len: phrase.length })
      }
    }
  }
  // Longest phrase first so the most specific match wins.
  entries.sort((a, b) => b.len - a.len)

  const dispositionFor = (keyword?: string | null): ClusterDisposition | null => {
    if (!keyword) return null
    const q = keyword.trim().toLowerCase()
    if (!q) return null
    for (const e of entries) {
      if (phraseContains(q, e.phrase)) return e.disposition
    }
    return null
  }
  return {
    dispositionFor,
    fit: (keyword) => weightForDisposition(dispositionFor(keyword)),
  }
}

/** Load the latest strategy and build a resolver. Falls back to all-neutral. */
export async function buildClusterFitResolver(tenantId: string): Promise<ClusterFitResolver> {
  try {
    const doc = await getLatestStrategy(tenantId)
    return buildResolverFromCore(doc?.core ?? null)
  } catch (err) {
    logger.warn('cluster_fit_resolver_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return buildResolverFromCore(null)
  }
}

/**
 * Page-level cluster-fit selection. Given the page's candidate queries each
 * with a weight (EV or impressions), return the keyword that should drive the
 * page's cluster_fit: the highest-weight query that maps to a real cluster, so
 * the page is credited to its most valuable on-strategy query rather than a
 * fringe high-disposition one or a generic token that maps nowhere. Falls back
 * to the highest-weight query overall (which resolves neutral) when none map.
 */
export function pickClusterFitKeyword(
  resolver: ClusterFitResolver,
  candidates: ReadonlyArray<{ keyword: string; weight: number }>,
): string | undefined {
  if (candidates.length === 0) return undefined
  const mapped = candidates.filter((c) => resolver.dispositionFor(c.keyword) !== null)
  const pool = mapped.length ? mapped : candidates
  return pool.reduce((best, c) => (c.weight > best.weight ? c : best)).keyword
}

/**
 * EV-weighted cluster-fit across a page's queries, over the MAPPED queries
 * only (unmapped queries are strategically silent and excluded). A page that
 * spans a defend query and an ignored query lands on an EV-weighted blend of
 * the two rather than being zeroed by whichever single query has higher EV.
 * Returns neutral 1.0 when no query maps to a cluster.
 */
export function blendClusterFit(
  resolver: ClusterFitResolver,
  candidates: ReadonlyArray<{ keyword: string; weight: number }>,
): number {
  let wsum = 0
  let fitsum = 0
  for (const c of candidates) {
    const d = resolver.dispositionFor(c.keyword)
    if (d === null) continue
    const w = Math.max(0, c.weight)
    wsum += w
    fitsum += w * weightForDisposition(d)
  }
  return wsum > 0 ? fitsum / wsum : NEUTRAL_FIT
}

/** Whole-phrase containment of any phrase within a query. Exported for cycles
 *  that need to test cluster membership directly (e.g. article_create). */
export function keywordInPhrases(query: string, phrases: ReadonlyArray<string>): boolean {
  const q = ' ' + query.trim().toLowerCase() + ' '
  for (const p of phrases) {
    const needle = p.trim().toLowerCase()
    if (needle && q.includes(' ' + needle + ' ')) return true
  }
  return false
}
