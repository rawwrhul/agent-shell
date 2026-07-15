// src/skills/seo-keyword-gap/gap.ts
//
// Pure logic for the keyword_gap cycle: parse Ahrefs organic-keywords rows,
// diff a competitor's ranking surface against ours, and map gap keywords to
// strategy clusters for secondary targeting. No I/O — unit-testable.
//
// Strategic intent (2026-07-15): every discovery cycle before this one was
// DEFENCE — grounded in keywords the site already ranks for (GSC). This is
// the ORIGINATION layer: keywords competitors hold that we don't, so the
// strategy can form attack clusters and copy/meta edits can target terms a
// page SHOULD rank for, not only re-optimise what it already has.

import { keywordInPhrases } from '../seo-discovery/cluster-fit'
import type { StrategyCore } from '../../core/strategy/types'

export interface CompetitorKeywordRow {
  keyword:    string
  position:   number
  volume:     number
  difficulty: number | null
  url:        string | null
}

export interface GapKeyword {
  keyword:            string
  volume:             number
  difficulty:         number | null
  bestCompetitorPos:  number
  competitorDomains:  string[]
  competitorUrl:      string | null   // the URL winning the keyword (content model)
}

/**
 * Parse the raw Ahrefs /site-explorer/organic-keywords payload into rows.
 * Ahrefs v3 returns { keywords: [...] } (fallback: top-level array). Skips
 * rows missing a keyword or position. Field names per client.ts select:
 * keyword, best_position, volume, sum_traffic, best_position_url,
 * keyword_difficulty.
 */
export function mapAhrefsOrganicRows(raw: unknown): CompetitorKeywordRow[] {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { keywords?: unknown[] })?.keywords)
      ? (raw as { keywords: unknown[] }).keywords
      : []
  const rows: CompetitorKeywordRow[] = []
  for (const it of items) {
    const r = it as Record<string, unknown>
    const keyword = typeof r.keyword === 'string' ? r.keyword.trim().toLowerCase() : ''
    const position = Number(r.best_position)
    if (!keyword || !Number.isFinite(position) || position <= 0) continue
    rows.push({
      keyword,
      position,
      volume:     Number.isFinite(Number(r.volume)) ? Number(r.volume) : 0,
      difficulty: r.keyword_difficulty != null && Number.isFinite(Number(r.keyword_difficulty)) ? Number(r.keyword_difficulty) : null,
      url:        typeof r.best_position_url === 'string' ? r.best_position_url : null,
    })
  }
  return rows
}

export interface DiffGapInput {
  /** competitor domain -> its parsed organic keyword rows */
  competitorRows:  ReadonlyMap<string, CompetitorKeywordRow[]>
  /** normalized (trim/lowercase) keywords WE already rank for (any position) */
  ourKeywords:     ReadonlySet<string>
  /** our brand tokens — a competitor outranking us on our own brand is noise */
  brandTokens:     ReadonlyArray<string>
  /** competitor position must be <= this to count as demonstrated winnability */
  maxPosition:     number
  /** keyword volume floor — below this the gap isn't worth strategy attention */
  minVolume:       number
}

/**
 * Diff competitor surfaces against ours. A keyword is a GAP when at least one
 * competitor ranks <= maxPosition for it, we do not rank for it at all, and it
 * is neither our brand nor the competitor's own brand (their domain tokens).
 * Aggregated across competitors (best position wins, domains accumulated),
 * sorted by volume desc.
 */
export function diffGap(input: DiffGapInput): GapKeyword[] {
  const byKeyword = new Map<string, GapKeyword>()
  for (const [domain, rows] of input.competitorRows) {
    const competitorBrand = domainTokens(domain)
    for (const row of rows) {
      if (row.position > input.maxPosition) continue
      if (row.volume < input.minVolume) continue
      if (input.ourKeywords.has(row.keyword)) continue
      const k = ' ' + row.keyword + ' '
      if (input.brandTokens.some((b) => b && k.includes(' ' + b + ' '))) continue
      if (competitorBrand.some((b) => row.keyword.includes(b))) continue

      const existing = byKeyword.get(row.keyword)
      if (!existing) {
        byKeyword.set(row.keyword, {
          keyword: row.keyword, volume: row.volume, difficulty: row.difficulty,
          bestCompetitorPos: row.position, competitorDomains: [domain],
          competitorUrl: row.url,
        })
      } else {
        if (!existing.competitorDomains.includes(domain)) existing.competitorDomains.push(domain)
        if (row.position < existing.bestCompetitorPos) {
          existing.bestCompetitorPos = row.position
          existing.competitorUrl = row.url
        }
        existing.volume = Math.max(existing.volume, row.volume)
      }
    }
  }
  return [...byKeyword.values()].sort((a, b) => b.volume - a.volume)
}

/** Brand-ish tokens from a domain: SLD split on non-letters, len >= 4.
 *  'davefenechelectrical.com.au' -> ['davefenechelectrical']. Length floor 4
 *  keeps generic short tokens ('the', 'ev') from over-filtering. */
export function domainTokens(domain: string): string[] {
  const sld = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0] ?? ''
  const toks = sld.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4)
  return toks.length ? toks : (sld.length >= 4 ? [sld.toLowerCase()] : [])
}

// ── cluster mapping (secondary targeting for copy/meta cycles) ─────────────

export interface GapSecondaryResolver {
  /** Gap keywords in the same strategy cluster as `keyword`, top by volume. */
  gapKeywordsFor(keyword: string | undefined | null, limit?: number): GapKeyword[]
}

/**
 * Map each gap keyword to the strategy clusters whose targetKeywords phrases
 * it contains (same whole-phrase containment as cluster-fit). Then, for a
 * page's dominant query, return the gap keywords sharing its cluster — these
 * are the attack terms the page should ALSO target when its copy/meta is
 * rewritten. Pure; loaders live in store.ts.
 */
export function buildGapSecondaryResolver(
  core: StrategyCore | null,
  gaps: ReadonlyArray<GapKeyword>,
): GapSecondaryResolver {
  // cluster topic -> gap keywords belonging to it
  const byCluster = new Map<string, GapKeyword[]>()
  const clusters = core?.portfolio ?? []
  for (const g of gaps) {
    for (const c of clusters) {
      if (keywordInPhrases(g.keyword, c.targetKeywords)) {
        const list = byCluster.get(c.topic) ?? []
        list.push(g)
        byCluster.set(c.topic, list)
      }
    }
  }
  for (const list of byCluster.values()) list.sort((a, b) => b.volume - a.volume)

  return {
    gapKeywordsFor(keyword, limit = 5): GapKeyword[] {
      if (!keyword) return []
      const out: GapKeyword[] = []
      const seen = new Set<string>()
      for (const c of clusters) {
        if (!keywordInPhrases(keyword, c.targetKeywords)) continue
        for (const g of byCluster.get(c.topic) ?? []) {
          if (g.keyword === keyword.trim().toLowerCase() || seen.has(g.keyword)) continue
          seen.add(g.keyword)
          out.push(g)
          if (out.length >= limit) return out
        }
      }
      return out
    },
  }
}
