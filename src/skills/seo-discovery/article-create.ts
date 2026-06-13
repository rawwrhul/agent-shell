// src/skills/seo-discovery/article-create.ts
//
// Phase 2, unit 3 (chunk 3c): the article_create discovery cycle.
//
// Unlike the optimization cycles, this works off the STRATEGY PORTFOLIO, not
// existing rankings. For each non-ignore cluster that has no page ranking in
// the top 10, it proposes a new article and scores it on demonstrated demand:
//   EV(monthly clicks) = Σ search_volume(targetKeywords) x ctrAtPosition(capture)
// Search volume comes from DataForSEO (cached 30d); if unavailable it falls
// back to in-DB impressions for the cluster's queries, and to zero (a strategic
// placeholder ranked by disposition) if there is no demand signal at all.
//
// cluster_fit is the cluster's own disposition weight (the article IS the
// cluster). probability (0.30) and weeks_to_impact (10) come from the per-
// action defaults — new content is a slow, uncertain bet, and the score
// reflects that. Files one opportunity per underserved cluster.
//
// This is discovery only. The authoring pipeline (write → humanise →
// fact-preserve → structural guard → SEO-score gate) is execution-time and
// runs when an article_create opportunity is approved.

import { v4 as uuid } from 'uuid'
import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import { ctrAtPosition } from '../../core/opportunity-bank/scoring'
import { getLatestStrategy } from '../../core/strategy/store'
import { weightForDisposition, keywordInPhrases } from './cluster-fit'
import { buildClusterFitResolver } from './cluster-fit'
import { buildConversionRateResolver } from './conversion-rate'
import { fileScoredOpportunity } from './file-opportunity'
import { loadRankingRows } from './common'
import { keywordOverview } from '../../integrations/dataforseo/client'
import { cachedJson } from '../../core/cache/cached-fetch'

const ACTION = 'article_create' as const
const CAPTURE_POSITION = 5    // assumed rank if a strong article is built + ranks
const SERVED_POSITION = 10    // cluster is "served" if a matching query ranks <= this
const VOLUME_TTL_SECONDS = 30 * 24 * 3600
const MAX_KEYWORDS = 50

export interface ArticleCreateResult {
  tenantId:   string
  scanned:    number   // clusters considered
  candidates: number   // underserved clusters
  filed:      number
  skipped:    number
  errors:     string[]
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'cluster'
}

/** Total DataForSEO search volume across a cluster's target keywords, cached.
 *  Returns null if the vendor call fails or credentials are absent. */
async function clusterSearchVolume(tenant: Awaited<ReturnType<typeof getTenant>>, topic: string, keywords: string[]): Promise<number | null> {
  if (!keywords.length) return null
  try {
    const { value } = await cachedJson<number>({
      pool, source: 'dataforseo_keyword_overview', key: `vol:${slugify(topic)}`,
      tenantId: tenant.tenantId, ttlSeconds: VOLUME_TTL_SECONDS,
      fetcher: async () => {
        const items = await keywordOverview(tenant, { keywords: keywords.slice(0, MAX_KEYWORDS) })
        return items.reduce((s, it) => s + (it.keyword_info?.search_volume ?? 0), 0)
      },
    })
    return value
  } catch (err) {
    logger.warn('article_create_volume_lookup_failed', { tenantId: tenant.tenantId, topic, err: String(err).slice(0, 150) })
    return null
  }
}

export async function runArticleCreateCycle(tenantId: string): Promise<ArticleCreateResult> {
  const runId = uuid()
  const result: ArticleCreateResult = { tenantId, scanned: 0, candidates: 0, filed: 0, skipped: 0, errors: [] }
  logger.info('article_create_cycle_starting', { tenantId, runId })

  let tenant
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    result.errors.push('tenant_not_found')
    logger.error('article_create_tenant_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return result
  }
  if ((tenant.disabledOpportunityTypes ?? []).includes(ACTION)) {
    logger.info('article_create_cycle_skipped_disabled', { tenantId })
    return result
  }

  const doc = await getLatestStrategy(tenantId)
  if (!doc || !doc.core.portfolio.length) {
    result.errors.push('no_strategy')
    logger.info('article_create_cycle_skipped_no_strategy', { tenantId })
    return result
  }

  const [clusterFit, convRate, rankingRows] = await Promise.all([
    buildClusterFitResolver(tenantId),
    buildConversionRateResolver(tenantId),
    loadRankingRows(tenantId).catch(() => []),
  ])

  const captureCtr = ctrAtPosition(CAPTURE_POSITION)

  for (const cluster of doc.core.portfolio) {
    if (cluster.disposition === 'ignore') continue
    result.scanned++

    const kws = cluster.targetKeywords ?? []
    const matching = rankingRows.filter((r) => keywordInPhrases(r.keyword, kws))
    // Served: a page already ranks well for this cluster — don't propose a
    // competing new article (cannibalization). Defend that page elsewhere.
    if (matching.some((r) => r.pos <= SERVED_POSITION)) continue
    result.candidates++

    const volume = await clusterSearchVolume(tenant, cluster.topic, kws)
    const inDbImpr = matching.reduce((s, r) => s + r.impressions, 0)
    let evClicks: number
    let demandSource: string
    if (volume !== null && volume > 0) {
      evClicks = volume * captureCtr
      demandSource = 'search_volume'
    } else if (inDbImpr > 0) {
      evClicks = inDbImpr * captureCtr
      demandSource = 'in_db_impressions'
    } else {
      evClicks = 0
      demandSource = 'unconfirmed'
    }

    const demandLine =
      demandSource === 'search_volume'   ? `~${volume} monthly searches across ${kws.length} target terms.` :
      demandSource === 'in_db_impressions' ? `${inDbImpr} impressions/mo already landing without a dedicated page.` :
                                            `Demand not yet confirmed (no volume data) — strategic bet.`

    const res = await fileScoredOpportunity({
      tenantId, runId, action: ACTION,
      target: `proposed:${slugify(cluster.topic)}`,
      keyword: kws[0],
      clusterFitOverride: weightForDisposition(cluster.disposition),
      evMonthlyClicks: evClicks,
      description: `Write new content for "${cluster.topic}"`,
      rationale:
        `Strategy cluster (${cluster.disposition}, priority ${cluster.priority}) has no page in the top 10. ` +
        demandLine,
      detail: {
        cluster_topic: cluster.topic,
        disposition: cluster.disposition,
        cluster_priority: cluster.priority,
        demand_source: demandSource,
        search_volume: volume,
        in_db_impressions: inDbImpr,
        capture_position: CAPTURE_POSITION,
        target_keywords: kws.slice(0, 10),
      },
    }, { clusterFit, convRate, cmsPathPrefixes: tenant.cmsPathPrefixes })
    if (res.filed) result.filed++
    else result.skipped++
  }

  logger.info('article_create_cycle_completed', result)
  return result
}
