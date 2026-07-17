// src/skills/seo-discovery/internal-link.ts
//
// Phase 2, unit 3: the internal_link discovery cycle.
//
// Signal: a PAGE with ranking potential (queries in striking distance, 5..30)
// that is under-linked internally — few non-nav content links point to it. Add
// internal links to pass equity and push position. EV is the striking-distance
// uplift, scored at the weaker 0.50 probability (links are a softer lever than
// content).
//
// Requires a crawl: link in-degree comes from seo_internal_links and the cycle
// is gated on seo_page_inventory being populated, otherwise every page looks
// "under-linked" simply because no crawl has run. URLs are matched exactly
// between GSC (ranking_history) and the crawler; if a trailing-slash / host
// normalization mismatch hides links, that surfaces as zero candidates.

import { v4 as uuid } from 'uuid'
import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import { evStrikingDistance } from '../../core/opportunity-bank/scoring'
import { buildClusterFitResolver } from './cluster-fit'
import { buildConversionRateResolver } from './conversion-rate'
import { fileScoredOpportunity } from './file-opportunity'
import { groupByPage, round2 } from './common'
import { loadRankingRowsOrFallback } from './ahrefs-fallback'

const ACTION = 'internal_link' as const
const MIN_POSITION = 5
const MAX_POSITION = 50
const MAX_CONTENT_INLINKS = 3   // strictly fewer than this = under-linked
const MAX_CANDIDATES = 150

interface Cand { keyword: string; pos: number; impressions: number; ev: number }

export interface InternalLinkResult {
  tenantId:   string
  scanned:    number
  candidates: number
  filed:      number
  skipped:    number
  errors:     string[]
}

export async function runInternalLinkCycle(tenantId: string): Promise<InternalLinkResult> {
  const runId = uuid()
  const result: InternalLinkResult = { tenantId, scanned: 0, candidates: 0, filed: 0, skipped: 0, errors: [] }
  logger.info('internal_link_cycle_starting', { tenantId, runId })

  let tenant
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    result.errors.push('tenant_not_found')
    logger.error('internal_link_tenant_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }
  if ((tenant.disabledOpportunityTypes ?? []).includes(ACTION)) {
    logger.info('internal_link_cycle_skipped_disabled', { tenantId })
    return result
  }

  // Gate on crawl presence: without inventory we cannot tell "under-linked"
  // from "never crawled".
  try {
    const inv = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int n FROM seo_page_inventory WHERE tenant_id=$1`, [tenantId],
    )
    if (Number(inv.rows[0]?.n ?? 0) === 0) {
      logger.info('internal_link_cycle_skipped_no_crawl', { tenantId })
      result.errors.push('no_crawl_data')
      return result
    }
  } catch (err) {
    result.errors.push(`inventory_check_failed: ${String(err).slice(0, 120)}`)
    logger.error('internal_link_inventory_check_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }

  // Non-nav content in-degree per target page.
  const inDeg = new Map<string, number>()
  try {
    const res = await pool.query<{ target_url: string; indeg: string }>(
      `SELECT target_url, COUNT(*)::int indeg
       FROM seo_internal_links
       WHERE tenant_id=$1 AND is_nav=false
       GROUP BY target_url`,
      [tenantId],
    )
    for (const r of res.rows) inDeg.set(r.target_url, Number(r.indeg))
  } catch (err) {
    result.errors.push(`indegree_query_failed: ${String(err).slice(0, 120)}`)
    logger.error('internal_link_indegree_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }

  const [clusterFit, convRate] = await Promise.all([
    buildClusterFitResolver(tenantId),
    buildConversionRateResolver(tenantId),
  ])

  let rows
  try {
    rows = await loadRankingRowsOrFallback(tenant)
  } catch (err) {
    result.errors.push(`ranking_query_failed: ${String(err).slice(0, 120)}`)
    logger.error('internal_link_ranking_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }

  const byPage = groupByPage(rows)
  result.scanned = byPage.size

  interface PageCandidate { pageUrl: string; inDegree: number; pageEv: number; queries: Cand[] }
  const candidates: PageCandidate[] = []

  for (const [pageUrl, kws] of byPage) {
    const inDegree = inDeg.get(pageUrl) ?? 0
    if (inDegree >= MAX_CONTENT_INLINKS) continue // adequately linked
    const queries: Cand[] = []
    for (const k of kws) {
      if (!(k.pos >= MIN_POSITION && k.pos <= MAX_POSITION) || k.impressions <= 0) continue
      const ev = evStrikingDistance({ impressions: k.impressions, currentPosition: k.pos })
      if (ev > 0) queries.push({ keyword: k.keyword, pos: k.pos, impressions: k.impressions, ev })
    }
    if (queries.length === 0) continue
    queries.sort((a, b) => b.ev - a.ev)
    const pageEv = queries.reduce((s, q) => s + q.ev, 0)
    candidates.push({ pageUrl, inDegree, pageEv, queries })
  }

  candidates.sort((a, b) => b.pageEv - a.pageEv)
  const top = candidates.slice(0, MAX_CANDIDATES)
  result.candidates = top.length

  for (const c of top) {
    const dominant = c.queries[0]
    const path = c.pageUrl.replace(/^https?:\/\/[^/]+/, '') || '/'
    const res = await fileScoredOpportunity({
      tenantId, runId, action: ACTION, target: c.pageUrl, keyword: dominant.keyword,
      clusterFitKeywords: c.queries.map((q) => ({ keyword: q.keyword, weight: q.ev })),
      evMonthlyClicks: c.pageEv,
      description: `Add internal links to ${path}`,
      rationale:
        `Page ranks in striking distance but has only ${c.inDegree} non-nav internal link(s) pointing in. ` +
        `Biggest opportunity: "${dominant.keyword}" at ~#${dominant.pos.toFixed(1)}. ` +
        `More internal links pass equity to push position.`,
      detail: {
        in_degree: c.inDegree,
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

  logger.info('internal_link_cycle_completed', result)
  return result
}
