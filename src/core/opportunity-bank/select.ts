// src/core/opportunity-bank/select.ts
//
// Selection algorithms for the opportunity bank. Two callers:
//
//   pickForDailyRun  — invoked by the daily-run aggregator. Picks a diverse,
//                      priority-weighted batch and atomically transitions the
//                      selected rows new → surfaced with surfaced_in_run_id
//                      stamped. Subsequent runs won't re-surface these.
//
//   pickForAdHoc     — invoked by the Slack `app_mention` handler before
//                      falling through to fresh discovery. Pulls only
//                      opportunities matching the requested types. Does NOT
//                      transition state — ad-hoc usage doesn't consume the
//                      bank, the daily run does.
//
// Scoring: priority weight × age boost. Diversity cap applied AFTER scoring
// to ensure no single type dominates the batch.

import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import {
  Opportunity, Priority, OppStatus,
  PRIORITY_WEIGHTS, FRESHNESS_WINDOW_DAYS, DIVERSITY_CAP_PER_TYPE,
  TYPE_BOOSTS, TYPE_DIVERSITY_CAPS,
  DEFAULT_SURFACE_LIMIT, ACTIONABLE_STATUSES,
} from './types'

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Pick a batch of opportunities to surface in today's daily run, and
 * atomically transition them from 'new' to 'surfaced'. Returns the rows
 * that successfully transitioned (in case of concurrent writers).
 */
export async function pickForDailyRun(input: {
  tenantId: string
  runId:    string
  limit?:   number
}): Promise<Opportunity[]> {
  const limit = input.limit ?? DEFAULT_SURFACE_LIMIT

  // 1. Load candidates: status='new', within freshness window.
  const candidates = await loadCandidates({
    tenantId:     input.tenantId,
    statuses:     ['new'],
    typeFilter:   null,
    withinDays:   FRESHNESS_WINDOW_DAYS,
    maxRows:      200,
  })

  if (candidates.length === 0) {
    logger.info('opportunity_bank_empty_for_daily_run', { tenantId: input.tenantId })
    return []
  }

  // 2. Score + diversity-cap pick.
  const picked = scoreAndPick(candidates, limit, DIVERSITY_CAP_PER_TYPE)
  if (picked.length === 0) return []

  // 3. Atomic transition. Optimistic concurrency: only transition rows
  //    still in 'new' state (some may have been picked up elsewhere).
  const transitionedIds = await transitionToSurfaced({
    ids:   picked.map((p) => p.id),
    runId: input.runId,
  })

  // 4. Return the rows that actually transitioned, with refreshed state.
  return picked
    .filter((p) => transitionedIds.has(p.id))
    .map((p) => ({ ...p, status: 'surfaced' as OppStatus,
                   surfacedInRunId: input.runId, surfacedAt: new Date() }))
}

/**
 * Pick opportunities matching a set of types for ad-hoc Slack mention
 * handling. Does NOT transition state — caller decides what to do with
 * results. Limit is small (default 5) since we're answering one question.
 */
export async function pickForAdHoc(input: {
  tenantId: string
  types:    string[]
  limit?:   number
}): Promise<Opportunity[]> {
  if (input.types.length === 0) return []
  const limit = input.limit ?? 5
  const candidates = await loadCandidates({
    tenantId:   input.tenantId,
    statuses:   ['new', 'surfaced'],   // surfaced-but-not-acted is still relevant for ad-hoc
    typeFilter: input.types,
    withinDays: FRESHNESS_WINDOW_DAYS,
    maxRows:    50,
  })
  return scoreAndPick(candidates, limit, DIVERSITY_CAP_PER_TYPE)
}

// ── Internals ───────────────────────────────────────────────────────────

interface CandidateLoadInput {
  tenantId:   string
  statuses:   OppStatus[]
  typeFilter: string[] | null
  withinDays: number
  maxRows:    number
}

async function loadCandidates(input: CandidateLoadInput): Promise<Opportunity[]> {
  const params: unknown[] = [input.tenantId, input.statuses, input.withinDays]
  let typeClause = ''
  if (input.typeFilter && input.typeFilter.length > 0) {
    typeClause = `AND type = ANY($4::text[])`
    params.push(input.typeFilter)
  }

  const sql = `
    SELECT
      id, tenant_id AS "tenantId", run_id AS "runId", type, target,
      description, rationale, priority, status,
      estimated_impact AS "estimatedImpact",
      created_at AS "createdAt", updated_at AS "updatedAt",
      surfaced_in_run_id AS "surfacedInRunId",
      surfaced_at AS "surfacedAt",
      dismissed_reason AS "dismissedReason",
      reshape_source_id AS "reshapeSourceId",
      reshape_target_id AS "reshapeTargetId",
      reshape_count AS "reshapeCount",
      resolved_run_id AS "resolvedRunId"
    FROM seo_opportunities
    WHERE tenant_id = $1
      AND status = ANY($2::text[])
      AND created_at > NOW() - ($3::int * INTERVAL '1 day')
      ${typeClause}
    ORDER BY priority ASC, created_at DESC
    LIMIT ${input.maxRows}
  `
  const result = await pool.query<Opportunity>(sql, params)
  return result.rows
}

/**
 * Score each candidate and select top N with a per-type cap.
 *
 * Scoring: `priorityWeight(P0=10/P1=6/P2=3) × ageBoost`
 *   ageBoost: linear from 1.0 (just created) to 0.5 (at the window edge).
 *
 * Diversity: iterate in descending score; skip any whose type has already
 * been picked `cap` times. Picks tie-break older-first for predictable
 * cycling.
 */
export function scoreAndPick(
  candidates: Opportunity[],
  limit:      number,
  capPerType: number,
): Opportunity[] {
  const now = Date.now()
  const windowMs = FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000

  const scored = candidates.map((c) => {
    const ageMs = now - c.createdAt.getTime()
    // 1.0 at age=0, 0.5 at age=windowMs, clamped.
    const ageBoost = Math.max(0.5, 1 - (0.5 * ageMs / windowMs))
    const typeBoost = TYPE_BOOSTS[c.type] ?? 1.0
    const score = (PRIORITY_WEIGHTS[c.priority] ?? 1) * ageBoost * typeBoost
    return { opp: c, score }
  })

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Tie-break: older first → predictable cycling through stalemates.
    return a.opp.createdAt.getTime() - b.opp.createdAt.getTime()
  })

  const picked: Opportunity[] = []
  const typeCounts = new Map<string, number>()
  for (const { opp } of scored) {
    if (picked.length >= limit) break
    const currentCount = typeCounts.get(opp.type) ?? 0
    const effectiveCap = TYPE_DIVERSITY_CAPS[opp.type] ?? capPerType
    if (currentCount >= effectiveCap) continue
    picked.push(opp)
    typeCounts.set(opp.type, currentCount + 1)
  }
  return picked
}

/**
 * Atomic state transition: 'new' → 'surfaced'. Returns the set of IDs
 * that actually transitioned. Optimistic — rows in any other state are
 * silently skipped.
 */
async function transitionToSurfaced(input: {
  ids:   string[]
  runId: string
}): Promise<Set<string>> {
  if (input.ids.length === 0) return new Set()
  const result = await pool.query<{ id: string }>(
    `UPDATE seo_opportunities
     SET status            = 'surfaced',
         surfaced_in_run_id = $2,
         surfaced_at        = NOW(),
         updated_at         = NOW()
     WHERE id = ANY($1::uuid[])
       AND status = 'new'
     RETURNING id`,
    [input.ids, input.runId],
  )
  const transitioned = new Set(result.rows.map((r) => r.id))
  if (transitioned.size < input.ids.length) {
    logger.info('opportunity_bank_concurrent_transition', {
      requested:    input.ids.length,
      transitioned: transitioned.size,
      missed:       input.ids.length - transitioned.size,
    })
  }
  return transitioned
}

// Re-exports for tests.
export { ACTIONABLE_STATUSES }
