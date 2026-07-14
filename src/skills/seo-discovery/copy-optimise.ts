// src/skills/seo-discovery/copy-optimise.ts
//
// Phase 2, unit 3: the copy_optimise discovery cycle.
//
// Signal: a PAGE with a foothold but not winning — queries ranking positions
// 5..30 — where the lever is on-page body content (depth, relevance) to push
// position up. Distinct from metadata_edit (position fine, CTR lagging → meta
// lever). Positions 1..4 are already winning and excluded. EV is the click
// uplift from reaching a stronger position, summed across the page's
// striking-distance queries (evStrikingDistance defaults to a top-3 target;
// the per-action 0.55 success probability discounts the optimism in scoring).
//
// Free data: ranking_history via the shared loader (per-query floor applied).
// Discovery only — the humanise / fact-preserve / SEO-gate authoring pipeline
// is execution-time and lands with article_create in chunk 3c.

import { v4 as uuid } from 'uuid'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import { evStrikingDistance } from '../../core/opportunity-bank/scoring'
import { buildClusterFitResolver } from './cluster-fit'
import { buildConversionRateResolver } from './conversion-rate'
import { fileScoredOpportunity } from './file-opportunity'
import { loadRankingRows, groupByPage, round2 } from './common'

const ACTION = 'copy_optimise' as const
const MIN_POSITION = 5
const MAX_POSITION = 50
const MAX_CANDIDATES = 150

interface Cand { keyword: string; pos: number; impressions: number; ev: number }

export interface CopyOptimiseResult {
  tenantId:   string
  scanned:    number
  candidates: number
  filed:      number
  skipped:    number
  errors:     string[]
}

export async function runCopyOptimiseCycle(tenantId: string): Promise<CopyOptimiseResult> {
  const runId = uuid()
  const result: CopyOptimiseResult = { tenantId, scanned: 0, candidates: 0, filed: 0, skipped: 0, errors: [] }
  logger.info('copy_optimise_cycle_starting', { tenantId, runId })

  let tenant
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    result.errors.push('tenant_not_found')
    logger.error('copy_optimise_tenant_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }
  if ((tenant.disabledOpportunityTypes ?? []).includes(ACTION)) {
    logger.info('copy_optimise_cycle_skipped_disabled', { tenantId })
    return result
  }

  const [clusterFit, convRate] = await Promise.all([
    buildClusterFitResolver(tenantId),
    buildConversionRateResolver(tenantId),
  ])

  let rows
  try {
    rows = await loadRankingRows(tenantId)
  } catch (err) {
    result.errors.push(`query_failed: ${String(err).slice(0, 150)}`)
    logger.error('copy_optimise_query_failed', { tenantId, err: String(err).slice(0, 300) })
    return result
  }

  const byPage = groupByPage(rows)
  result.scanned = byPage.size

  interface PageCandidate { pageUrl: string; pageImpressions: number; pageEv: number; queries: Cand[] }
  const candidates: PageCandidate[] = []

  for (const [pageUrl, kws] of byPage) {
    const pageImpressions = kws.reduce((s, k) => s + k.impressions, 0)
    const queries: Cand[] = []
    for (const k of kws) {
      if (!(k.pos >= MIN_POSITION && k.pos <= MAX_POSITION) || k.impressions <= 0) continue
      const ev = evStrikingDistance({ impressions: k.impressions, currentPosition: k.pos })
      if (ev > 0) queries.push({ keyword: k.keyword, pos: k.pos, impressions: k.impressions, ev })
    }
    if (queries.length === 0) continue
    queries.sort((a, b) => b.ev - a.ev)
    const pageEv = queries.reduce((s, q) => s + q.ev, 0)
    candidates.push({ pageUrl, pageImpressions, pageEv, queries })
  }

  candidates.sort((a, b) => b.pageEv - a.pageEv)
  const top = candidates.slice(0, MAX_CANDIDATES)
  result.candidates = top.length

  for (const c of top) {
    const dominant = c.queries[0]
    const path = c.pageUrl.replace(/^https?:\/\/[^/]+/, '') || '/'
    const qWord = c.queries.length === 1 ? 'query' : 'queries'
    const res = await fileScoredOpportunity({
      tenantId, runId, action: ACTION, target: c.pageUrl, keyword: dominant.keyword,
      clusterFitKeywords: c.queries.map((q) => ({ keyword: q.keyword, weight: q.ev })),
      evMonthlyClicks: c.pageEv,
      description: `Strengthen on-page content on ${path}`,
      rationale:
        `Page has a foothold on ${c.queries.length} ${qWord} ranking 5-30 with room to climb. ` +
        `Biggest: "${dominant.keyword}" at ~#${dominant.pos.toFixed(1)}, ${dominant.impressions} impr. ` +
        `Body depth/relevance is the lever to push position.`,
      detail: {
        page_impressions: c.pageImpressions,
        query_count: c.queries.length,
        dominant_keyword: dominant.keyword,
        top_keywords: c.queries.slice(0, 5).map((q) => ({
          keyword: q.keyword, position: round2(q.pos), impressions: q.impressions, ev_clicks: round2(q.ev),
        })),
      },
    }, { clusterFit, convRate, cmsPathPrefixes: tenant.cmsPathPrefixes })
    if (res.filed) result.filed++
    else result.skipped++
  }

  logger.info('copy_optimise_cycle_completed', result)
  return result
}
