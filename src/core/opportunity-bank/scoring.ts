// src/core/opportunity-bank/scoring.ts
//
// Phase 2, build unit 1: deterministic EV scoring for the opportunity bank.
//
// The whole bank now ranks on one number:
//
//     score = expected_monthly_conversion_change / weeks_to_impact
//
// expected_monthly_conversion_change is probability-weighted and cluster-fit
// weighted (both folded into the single number, NOT separate multipliers on
// the score). weeks_to_impact is realisation lag (not execution time) and is
// also the calibration timing gate elsewhere.
//
// Everything here is pure (no DB, no LLM, no I/O) so it is unit-testable and
// honours the "deterministic calculators over LLM numbers" rule. The action
// cycles (build unit 3) call evX() + scoreOpportunity(); the backfill CLI
// (this unit) uses defaultScoreForPriority() for legacy rows it can't compute
// EV for.

export type ActionType =
  | 'article_create'
  | 'metadata_edit'
  | 'copy_optimise'
  | 'internal_link'
  | 'backlink_hunt'
  | 'technical_seo'

export const ACTION_TYPES: readonly ActionType[] = [
  'article_create', 'metadata_edit', 'copy_optimise',
  'internal_link', 'backlink_hunt', 'technical_seo',
] as const

// ── CTR curve ────────────────────────────────────────────────────────────
//
// Generic organic position→CTR curve (decision 4). Pluggable: pass a
// per-tenant curve derived from ranking_history once a tenant has enough
// position coverage. Values are industry-approximate; calibration does not
// touch this (it is an input to EV, not a learned prior).

export const GENERIC_CTR_CURVE: Readonly<Record<number, number>> = {
  1: 0.281, 2: 0.152, 3: 0.099, 4: 0.067, 5: 0.050,
  6: 0.039, 7: 0.031, 8: 0.025, 9: 0.021, 10: 0.018,
}

export function ctrAtPosition(
  position: number,
  curve: Readonly<Record<number, number>> = GENERIC_CTR_CURVE,
): number {
  if (!Number.isFinite(position) || position < 1) return curve[1] ?? 0.281
  const p = Math.round(position)
  if (p <= 10) return curve[p] ?? curve[10] ?? 0.018
  if (p <= 20) return Math.max(0.003, 0.018 - (p - 10) * 0.0014) // taper ~0.018→0.004
  return 0.003
}

// ── Per-action defaults ──────────────────────────────────────────────────
//
// weeks_to_impact: realisation lag per action (not execution time — the agent
// ships same-day). Used as the score divisor and the calibration grading gate.

export const DEFAULT_WEEKS_TO_IMPACT: Readonly<Record<ActionType, number>> = {
  metadata_edit:  3,
  internal_link:  2,
  copy_optimise:  3,
  technical_seo:  3,
  article_create: 10,
  backlink_hunt:  12,
}

// Base success probability per action, folded INTO expected value. Tunable
// starting priors; build unit 8 (calibration) replaces these with learned
// per-action priors from realised-vs-predicted outcomes.
export const BASE_PROBABILITY: Readonly<Record<ActionType, number>> = {
  metadata_edit:  0.70,
  copy_optimise:  0.55,
  internal_link:  0.50,
  technical_seo:  0.50,
  article_create: 0.30,
  backlink_hunt:  0.20,
}

/** weeks_to_impact is floored so the divisor can never be 0 or sub-week. */
export const WEEKS_FLOOR = 1

// ── Composite score ────────────────────────────────────────────────────────

export interface ScoreInput {
  action:          ActionType
  /** Estimated incremental monthly clicks from the per-action estimator. */
  evMonthlyClicks: number
  /** Realisation lag; defaults to the per-action value. */
  weeksToImpact?:  number
  /** 0..1 success probability; defaults to the per-action base prior. */
  probability?:    number
  /** Strategy cluster-fit weight (0..1+); defaults to 1 (neutral). */
  clusterFit?:     number
  /**
   * Conversions per click for the target page (from traffic_history).
   * When present and > 0 the score is in conversions; otherwise it falls
   * back to clicks (decision 3). Ranking is intra-tenant, so a consistent
   * currency per tenant is all that is required.
   */
  pageConvRate?:   number | null
}

export interface ScoreResult {
  score:                 number
  expectedMonthlyChange: number
  currency:              'conversions' | 'clicks'
  evMonthlyClicks:       number
  evMonthlyConversions:  number | null
  weeksToImpact:         number
  probability:           number
  clusterFit:            number
  scoreInputs:           Record<string, unknown>
}

export function scoreOpportunity(input: ScoreInput): ScoreResult {
  const probability = clamp01(input.probability ?? BASE_PROBABILITY[input.action])
  const clusterFit  = Math.max(0, input.clusterFit ?? 1)
  const weeks       = Math.max(WEEKS_FLOOR, input.weeksToImpact ?? DEFAULT_WEEKS_TO_IMPACT[input.action])
  const clicks      = Math.max(0, input.evMonthlyClicks)

  const useConv  = typeof input.pageConvRate === 'number' && input.pageConvRate > 0
  const currency: 'conversions' | 'clicks' = useConv ? 'conversions' : 'clicks'
  const conversions = useConv ? clicks * (input.pageConvRate as number) : null
  const magnitude   = useConv ? (conversions as number) : clicks

  const expected = magnitude * probability * clusterFit
  const score    = expected / weeks

  return {
    score,
    expectedMonthlyChange: expected,
    currency,
    evMonthlyClicks:      clicks,
    evMonthlyConversions: conversions,
    weeksToImpact:        weeks,
    probability,
    clusterFit,
    scoreInputs: {
      action: input.action,
      currency,
      evMonthlyClicks: clicks,
      pageConvRate: useConv ? input.pageConvRate : null,
      probability,
      clusterFit,
      weeksToImpact: weeks,
    },
  }
}

// ── Per-action EV estimators (clicks) ──────────────────────────────────────
//
// The two grounded estimators ship in unit 1 (they back metadata_edit and
// copy_optimise, the high-confidence daily actions). The remaining four land
// with their cycles in unit 3.

/**
 * Striking-distance / CTR-gap uplift: extra monthly clicks from moving a
 * page from its current position to a target position, at fixed impressions.
 * Backs metadata_edit (when position is fine but CTR is below curve) and the
 * ranking-gap path of copy_optimise.
 */
export function evStrikingDistance(p: {
  impressions:      number
  currentPosition:  number
  targetPosition?:  number
  curve?:           Readonly<Record<number, number>>
}): number {
  const target = p.targetPosition ?? Math.max(1, Math.min(3, Math.floor(p.currentPosition) - 2))
  const uplift = ctrAtPosition(target, p.curve) - ctrAtPosition(p.currentPosition, p.curve)
  return Math.max(0, p.impressions * uplift)
}

/**
 * Decay recovery: clicks recoverable by restoring a declining page to its
 * recent peak. Backs the decay path of copy_optimise.
 */
export function evDecayRecovery(p: { clicksPeak: number; clicksNow: number }): number {
  return Math.max(0, p.clicksPeak - p.clicksNow)
}

// ── Priority banding (decision 2) ───────────────────────────────────────────
//
// Priority is now DERIVED from score, not assigned by the LLM. Thresholds are
// absolute starting cuts in the score's units; calibration may move these to
// percentile banding once distributions settle. Kept consistent with
// DEFAULT_SCORE_FOR_PRIORITY so the legacy backfill round-trips.

export const PRIORITY_BANDS = { P0: 8, P1: 2 } as const

export function priorityFromScore(score: number): 'P0' | 'P1' | 'P2' {
  if (!Number.isFinite(score)) return 'P2'
  if (score >= PRIORITY_BANDS.P0) return 'P0'
  if (score >= PRIORITY_BANDS.P1) return 'P1'
  return 'P2'
}

/**
 * Conservative placeholder score for legacy rows whose EV we cannot compute
 * (no structured target+keyword). Maps the row's existing priority to a
 * default score so the switch to score-ordering keeps P0>P1>P2 sane until a
 * cycle re-files the row with a real EV (decision 2).
 */
export const DEFAULT_SCORE_FOR_PRIORITY: Readonly<Record<'P0' | 'P1' | 'P2', number>> = {
  P0: 9, P1: 3, P2: 0.5,
}

export function defaultScoreForPriority(priority: string): number {
  return DEFAULT_SCORE_FOR_PRIORITY[priority as 'P0' | 'P1' | 'P2'] ?? DEFAULT_SCORE_FOR_PRIORITY.P2
}

// ── helpers ──────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}
