// src/skills/seo-keyword-gap/index.ts
//
// The keyword_gap origination cycle. Ahrefs organic keywords per configured
// competitor (30d vendor cache), diffed against our GSC ranking surface,
// persisted to seo.keyword_gap. Consumers:
//   - strategy_refresh: "keywords competitors hold that we don't" prompt
//     section -> attack clusters -> article_create inherits them
//   - copy_optimise / metadata_edit: secondary gap keywords per page
//
// Silent, deterministic, no LLM. Cost: one Ahrefs organic-keywords report per
// competitor per 30 days (cache TTL = cadence; re-runs within the window are
// free).

import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import { pool } from '../../memory/postgres'
import { cachedJson } from '../../core/cache/cached-fetch'
import { organicKeywords } from '../../integrations/ahrefs/client'
import { getLatestStrategy } from '../../core/strategy/store'
import { mapAhrefsOrganicRows, diffGap, buildGapSecondaryResolver, domainTokens } from './gap'
import type { CompetitorKeywordRow, GapKeyword, GapSecondaryResolver } from './gap'
import { upsertGapRows, loadGapRows, loadOurKeywordSet } from './store'

export type { GapKeyword, GapSecondaryResolver } from './gap'
export { buildGapSecondaryResolver } from './gap'

const COUNTRY = 'au'
const KEYWORDS_PER_COMPETITOR = 300
const MAX_COMPETITOR_POSITION = 20
const MIN_VOLUME = 10
const CACHE_TTL_SECONDS = 30 * 24 * 3600

export interface KeywordGapResult {
  tenantId:           string
  competitorsScanned: number
  gapsFound:          number
  written:            number
  errors:             string[]
}

export async function runKeywordGapCycle(tenantId: string): Promise<KeywordGapResult> {
  const result: KeywordGapResult = { tenantId, competitorsScanned: 0, gapsFound: 0, written: 0, errors: [] }
  logger.info('keyword_gap_cycle_starting', { tenantId })

  let tenant
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    result.errors.push('tenant_not_found')
    logger.error('keyword_gap_tenant_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }

  const competitors = tenant.competitorDomains ?? []
  if (competitors.length === 0) {
    logger.info('keyword_gap_no_competitors_configured', {
      tenantId, hint: 'Set tenants.competitor_domains — same config the backlink prospector uses.',
    })
    return result
  }

  const ourKeywords = await loadOurKeywordSet(tenantId)

  const competitorRows = new Map<string, CompetitorKeywordRow[]>()
  for (const domain of competitors) {
    try {
      const { value } = await cachedJson<unknown>({
        pool, source: 'ahrefs_organic_keywords', key: `kw:${domain}:${COUNTRY}:${KEYWORDS_PER_COMPETITOR}`,
        tenantId, ttlSeconds: CACHE_TTL_SECONDS,
        fetcher: () => organicKeywords(domain, 'subdomains', COUNTRY, KEYWORDS_PER_COMPETITOR),
      })
      competitorRows.set(domain, mapAhrefsOrganicRows(value))
      result.competitorsScanned++
    } catch (err) {
      result.errors.push(`ahrefs_failed:${domain}`)
      logger.warn('keyword_gap_competitor_fetch_failed', { tenantId, domain, err: String(err).slice(0, 200) })
    }
  }

  const brand = brandTokensFor(tenant)
  const gaps = diffGap({
    competitorRows, ourKeywords, brandTokens: brand,
    maxPosition: MAX_COMPETITOR_POSITION, minVolume: MIN_VOLUME,
  })
  result.gapsFound = gaps.length
  result.written = await upsertGapRows(tenantId, gaps)

  logger.info('keyword_gap_cycle_completed', { ...result })
  return result
}

/** Same brand-token derivation the strategy refresh uses (client name words +
 *  domain SLD tokens), so gap filtering and surface filtering agree. */
function brandTokensFor(tenant: { clientName: string; targetDomain?: string | null }): string[] {
  const toks = new Set<string>()
  for (const t of tenant.clientName.toLowerCase().split(/\s+/)) if (t.length >= 3) toks.add(t)
  if (tenant.targetDomain) for (const t of domainTokens(tenant.targetDomain)) toks.add(t)
  return [...toks]
}

// ── consumer helpers ────────────────────────────────────────────────────────

/**
 * "Landscape data" section for the strategy refresh prompt: the top gap
 * keywords, formatted with volume, competitor position, and holder. Empty
 * string when no gap data exists (prompt section is omitted).
 */
export async function gatherKeywordGapContext(tenantId: string, limit = 40): Promise<string> {
  const gaps = await loadGapRows(tenantId, limit)
  if (!gaps.length) return ''
  const lines = gaps.map((g) =>
    `- "${g.keyword}" — ${g.volume} vol/mo, competitor #${g.bestCompetitorPos} (${g.competitorDomains[0] ?? '?'})` +
    (g.difficulty !== null ? `, KD ${g.difficulty}` : ''))
  return [
    `Keywords competitors rank top-${MAX_COMPETITOR_POSITION} for that WE DO NOT RANK FOR AT ALL (Ahrefs competitor gap).`,
    `These are ATTACK candidates: form attack/grow clusters around the winnable ones (volume vs difficulty vs our authority), and fold them into targetKeywords of existing clusters where they fit. Do not chase every term — pick the fronts.`,
    ...lines,
  ].join('\n')
}

/**
 * Build the secondary-targeting resolver for discovery cycles: gap keywords
 * grouped by strategy cluster. Best-effort — returns an empty resolver on any
 * failure so discovery cycles never break on gap data.
 */
export async function buildGapResolverForTenant(tenantId: string): Promise<GapSecondaryResolver> {
  try {
    const [doc, gaps] = await Promise.all([getLatestStrategy(tenantId), loadGapRows(tenantId)])
    return buildGapSecondaryResolver(doc?.core ?? null, gaps)
  } catch (err) {
    logger.warn('keyword_gap_resolver_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return buildGapSecondaryResolver(null, [])
  }
}
