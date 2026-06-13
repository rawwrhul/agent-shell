// src/skills/seo-discovery/file-opportunity.ts
//
// Phase 2, unit 3: the single primitive every discovery cycle uses to file a
// scored opportunity. It connects unit 1 (scoring) and unit 2 (strategy):
//
//   resolve cluster_fit (strategy) + conversion rate (history)
//     → scoreOpportunity (deterministic EV)
//     → derive priority from score
//     → dedupe against open opps for the same (tenant, action, target)
//     → INSERT into seo_opportunities with score + ev + score_inputs
//
// Semantic (embedding) dedup and cooldown are unit 6; this is the cheap
// exact-target guard so a cycle re-run doesn't re-file the same page daily.

import { v4 as uuid } from 'uuid'
import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import {
  scoreOpportunity, priorityFromScore, ActionType,
} from '../../core/opportunity-bank/scoring'
import type { ClusterFitResolver } from './cluster-fit'
import { blendClusterFit, pickClusterFitKeyword } from './cluster-fit'
import type { ConversionRateResolver } from './conversion-rate'

/** Actions the operator executes by hand regardless of target. */
const MANUAL_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>(['backlink_hunt'])

/**
 * Is this target a CMS/blog item (automatable) vs a marketing page (not)?
 *   - true  : confirmed CMS item (path under a configured CMS prefix)
 *   - false : confirmed not CMS (the site root is never a CMS item)
 *   - null  : unknown (no prefixes configured and not the root)
 */
export function isCmsTarget(target: string | null, cmsPathPrefixes?: string[]): boolean | null {
  if (!target) return null
  let path: string
  try { path = new URL(target).pathname } catch { path = target.replace(/^https?:\/\/[^/]+/, '') }
  if (path === '' || path === '/') return false // homepage is never a CMS item
  if (cmsPathPrefixes && cmsPathPrefixes.length) {
    return cmsPathPrefixes.some((p) => path.startsWith(p))
  }
  return null
}

/**
 * Execution mode is DERIVED, never scored. metadata_edit is the only action
 * whose mode depends on the target: Framer can rewrite blog/CMS meta
 * (automated) but not marketing-page meta (operator does it by hand). Every
 * other automatable action has an executor that covers both surfaces, so they
 * stay automated; backlink_hunt is operator-executed by design. As executors
 * for new surfaces ship, modes flip here without touching the score.
 */
export function executionModeFor(
  action: ActionType,
  target?: string | null,
  opts?: { cmsPathPrefixes?: string[] },
): 'automated' | 'manual' {
  if (MANUAL_ACTIONS.has(action)) return 'manual'
  if (action === 'metadata_edit') {
    return isCmsTarget(target ?? null, opts?.cmsPathPrefixes) === false ? 'manual' : 'automated'
  }
  return 'automated'
}

export interface DiscoveryResolvers {
  clusterFit:       ClusterFitResolver
  convRate:         ConversionRateResolver
  /** Per-tenant CMS/blog path prefixes; sharpens execution-mode classification. */
  cmsPathPrefixes?: string[]
}

export interface FileCandidate {
  tenantId:        string
  runId:           string
  action:          ActionType
  target:          string | null
  keyword?:        string
  /** Page-level cluster-fit: EV-weighted blend across these queries (preferred
   *  for ranking-driven cycles spanning multiple clusters). */
  clusterFitKeywords?: ReadonlyArray<{ keyword: string; weight: number }>
  /** Direct cluster-fit weight (cluster-native actions like article_create
   *  that know their disposition outright). Takes precedence. */
  clusterFitOverride?: number
  evMonthlyClicks: number
  weeksToImpact?:  number
  probability?:    number
  description:     string
  rationale?:      string
  detail?:         Record<string, unknown>
}

export interface FileResult {
  filed:   boolean
  id?:     string
  score?:  number
  skipped?: boolean
  reason?: string
}

export async function fileScoredOpportunity(
  c: FileCandidate,
  resolvers: DiscoveryResolvers,
): Promise<FileResult> {
  // Exact-target dedup: never re-file an open opportunity for the same lever
  // on the same target.
  if (c.target) {
    try {
      const dup = await pool.query(
        `SELECT 1 FROM seo_opportunities
         WHERE tenant_id=$1 AND type=$2 AND target IS NOT DISTINCT FROM $3
           AND status IN ('new','surfaced','queued','in_progress') LIMIT 1`,
        [c.tenantId, c.action, c.target],
      )
      if ((dup.rowCount ?? 0) > 0) return { filed: false, skipped: true, reason: 'duplicate' }
    } catch (err) {
      logger.warn('file_opportunity_dedup_check_failed', { tenantId: c.tenantId, err: String(err).slice(0, 150) })
    }
  }

  let clusterFit: number
  let fitKeyword: string | undefined
  if (typeof c.clusterFitOverride === 'number') {
    clusterFit = c.clusterFitOverride
    fitKeyword = c.keyword
  } else if (c.clusterFitKeywords && c.clusterFitKeywords.length) {
    clusterFit = blendClusterFit(resolvers.clusterFit, c.clusterFitKeywords)
    fitKeyword = pickClusterFitKeyword(resolvers.clusterFit, c.clusterFitKeywords) ?? c.keyword
  } else {
    clusterFit = resolvers.clusterFit.fit(c.keyword)
    fitKeyword = c.keyword
  }
  const convRate = c.target
    ? await resolvers.convRate.rateFor(c.target)
    : resolvers.convRate.tenantRate()

  const scored = scoreOpportunity({
    action:          c.action,
    evMonthlyClicks: c.evMonthlyClicks,
    weeksToImpact:   c.weeksToImpact,
    probability:     c.probability,
    clusterFit,
    pageConvRate:    convRate,
  })

  const priority = priorityFromScore(scored.score)
  const id = uuid()
  const detail = {
    ...(c.detail ?? {}),
    execution_mode: executionModeFor(c.action, c.target, { cmsPathPrefixes: resolvers.cmsPathPrefixes }),
    cluster_fit:    clusterFit,
    cluster_fit_keyword: fitKeyword ?? null,
  }
  const estimatedImpact = `~${round1(scored.expectedMonthlyChange)} ${scored.currency}/mo`

  try {
    await pool.query(
      `INSERT INTO seo_opportunities (
         id, tenant_id, run_id, type, target, description, rationale,
         priority, status, estimated_impact,
         score, ev_monthly_clicks, ev_monthly_conversions, weeks_to_impact,
         score_inputs, detail, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new',$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,NOW(),NOW())`,
      [
        id, c.tenantId, c.runId, c.action, c.target, c.description, c.rationale ?? null,
        priority, estimatedImpact,
        scored.score, scored.evMonthlyClicks, scored.evMonthlyConversions, scored.weeksToImpact,
        JSON.stringify(scored.scoreInputs), JSON.stringify(detail),
      ],
    )
  } catch (err) {
    logger.warn('file_opportunity_insert_failed', { tenantId: c.tenantId, action: c.action, err: String(err).slice(0, 200) })
    return { filed: false, skipped: true, reason: 'insert_failed' }
  }

  return { filed: true, id, score: scored.score }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
