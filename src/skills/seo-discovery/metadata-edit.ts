// src/skills/seo-discovery/metadata-edit.ts
//
// Phase 2, unit 3: the metadata_edit discovery cycle.
//
// Signal: a PAGE that ranks in striking distance (position <= 20) for queries
// whose CTR is below the curve expectation. Title/meta is a page-level lever —
// rewriting it moves CTR across every query the page shows for — so EV and the
// impression floor are computed at the page grain. Per-page EV is the sum of
// recoverable click gaps across the page's striking-distance queries:
// Σ impressions_kw x (expectedCTR(pos_kw) - actualCTR_kw), positive gaps only.
// One opportunity is filed per page.
//
// Free data: reads ranking_history via the shared loader (which applies the
// per-query impression floor). Deterministic; no LLM in discovery or scoring.

import { v4 as uuid } from 'uuid'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import { ctrAtPosition } from '../../core/opportunity-bank/scoring'
import { buildClusterFitResolver } from './cluster-fit'
import { buildConversionRateResolver } from './conversion-rate'
import { fileScoredOpportunity } from './file-opportunity'
import { groupByPage, round2, round4 } from './common'
import { loadRankingRowsOrFallback } from './ahrefs-fallback'
import { buildGapResolverForTenant } from '../seo-keyword-gap'

const ACTION = 'metadata_edit' as const
const MAX_POSITION = 30
const CTR_GAP_RATIO = 0.7   // a query's actual CTR must be below 70% of expected to count
const MAX_CANDIDATES = 150

interface Gap { keyword: string; pos: number; impressions: number; actualCtr: number; expectedCtr: number; ev: number }

export interface MetadataEditResult {
  tenantId:   string
  scanned:    number   // pages examined
  candidates: number   // pages that qualified
  filed:      number
  skipped:    number
  errors:     string[]
}

export async function runMetadataEditCycle(tenantId: string): Promise<MetadataEditResult> {
  const runId = uuid()
  const result: MetadataEditResult = { tenantId, scanned: 0, candidates: 0, filed: 0, skipped: 0, errors: [] }
  logger.info('metadata_edit_cycle_starting', { tenantId, runId })

  let tenant
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    result.errors.push('tenant_not_found')
    logger.error('metadata_edit_tenant_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }
  if ((tenant.disabledOpportunityTypes ?? []).includes(ACTION)) {
    logger.info('metadata_edit_cycle_skipped_disabled', { tenantId })
    return result
  }

  const [clusterFit, convRate, gapResolver] = await Promise.all([
    buildClusterFitResolver(tenantId),
    buildConversionRateResolver(tenantId),
    buildGapResolverForTenant(tenantId),
  ])

  let rows
  try {
    rows = await loadRankingRowsOrFallback(tenant)
  } catch (err) {
    result.errors.push(`query_failed: ${String(err).slice(0, 150)}`)
    logger.error('metadata_edit_query_failed', { tenantId, err: String(err).slice(0, 300) })
    return result
  }

  const byPage = groupByPage(rows)
  result.scanned = byPage.size

  interface PageCandidate { pageUrl: string; pageImpressions: number; pageEv: number; gaps: Gap[] }
  const candidates: PageCandidate[] = []

  for (const [pageUrl, kws] of byPage) {
    const pageImpressions = kws.reduce((s, k) => s + k.impressions, 0)
    const gaps: Gap[] = []
    for (const k of kws) {
      if (!(k.pos >= 1 && k.pos <= MAX_POSITION) || k.impressions <= 0) continue
      const actualCtr = k.clicks / k.impressions
      const expectedCtr = ctrAtPosition(k.pos)
      if (actualCtr < expectedCtr * CTR_GAP_RATIO) {
        const ev = k.impressions * (expectedCtr - actualCtr) // > 0 here
        gaps.push({ keyword: k.keyword, pos: k.pos, impressions: k.impressions, actualCtr, expectedCtr, ev })
      }
    }
    if (gaps.length === 0) continue
    gaps.sort((a, b) => b.ev - a.ev)
    const pageEv = gaps.reduce((s, g) => s + g.ev, 0)
    candidates.push({ pageUrl, pageImpressions, pageEv, gaps })
  }

  candidates.sort((a, b) => b.pageEv - a.pageEv)
  const top = candidates.slice(0, MAX_CANDIDATES)
  result.candidates = top.length

  for (const c of top) {
    const dominant = c.gaps[0]
    const path = c.pageUrl.replace(/^https?:\/\/[^/]+/, '') || '/'
    const gapWord = c.gaps.length === 1 ? 'query' : 'queries'
    // Attack terms: gap keywords in the same strategy cluster as this page's
    // dominant query — terms the page SHOULD rank for but holds nothing on.
    // Carried in detail so the drafting agent can fold them into title/meta.
    const attack = gapResolver.gapKeywordsFor(dominant.keyword, 3)
    const res = await fileScoredOpportunity({
      tenantId, runId, action: ACTION, target: c.pageUrl, keyword: dominant.keyword,
      clusterFitKeywords: c.gaps.map((g) => ({ keyword: g.keyword, weight: g.ev })),
      evMonthlyClicks: c.pageEv,
      description: `Rewrite title/meta on ${path}`,
      rationale:
        `Page ranks for ${c.gaps.length} ${gapWord} in striking distance with CTR below curve. ` +
        `Biggest gap: "${dominant.keyword}" at ~#${dominant.pos.toFixed(1)}, ` +
        `${(dominant.actualCtr * 100).toFixed(1)}% vs ~${(dominant.expectedCtr * 100).toFixed(1)}% expected. ` +
        `Title/meta is the page-level lever.` +
        (attack.length
          ? ` ALSO target (competitor-gap terms in this cluster we rank NOTHING for): ${attack.map((a) => `"${a.keyword}" (${a.volume}/mo)`).join(', ')}.`
          : ''),
      detail: {
        page_impressions: c.pageImpressions,
        gap_count: c.gaps.length,
        dominant_keyword: dominant.keyword,
        top_keywords: c.gaps.slice(0, 5).map((g) => ({
          keyword: g.keyword, position: round2(g.pos), impressions: g.impressions,
          actual_ctr: round4(g.actualCtr), expected_ctr: round4(g.expectedCtr), ev_clicks: round2(g.ev),
        })),
        secondary_gap_keywords: attack.map((a) => ({
          keyword: a.keyword, volume: a.volume, competitor_position: a.bestCompetitorPos,
          competitor: a.competitorDomains[0] ?? null,
        })),
      },
    }, { clusterFit, convRate, cmsPathPrefixes: tenant.cmsPathPrefixes })
    if (res.filed) result.filed++
    else result.skipped++
  }

  logger.info('metadata_edit_cycle_completed', result)
  return result
}
