// src/core/opportunity-bank/types.ts
//
// Shared types for the opportunity bank. Status lifecycle, scoring constants,
// reshape limits, ad-hoc match types.

export type OppStatus =
  | 'new'           // discovered by a background run, not yet shown to customer
  | 'surfaced'      // shown to customer in a daily run, awaiting operator action
  | 'queued'        // operator approved; executor will pick this up
  | 'in_progress'   // executor running
  | 'executed'      // done (terminal)
  | 'rejected'      // operator rejected (terminal; may have reshape_target_id set)
  | 'stale'         // aged out without action (terminal)

export const TERMINAL_STATUSES: readonly OppStatus[] =
  ['executed', 'rejected', 'stale'] as const

export const ACTIONABLE_STATUSES: readonly OppStatus[] =
  ['new', 'surfaced', 'queued', 'in_progress'] as const

export type Priority = 'P0' | 'P1' | 'P2'

/** Canonical row shape, including all bank columns. */
export interface Opportunity {
  id:                 string
  tenantId:           string
  runId:              string
  type:               string
  target:             string | null
  description:        string
  rationale:          string | null
  priority:           Priority
  status:             OppStatus
  estimatedImpact:    string | null
  createdAt:          Date
  updatedAt:          Date
  surfacedInRunId:    string | null
  surfacedAt:         Date | null
  dismissedReason:    string | null
  reshapeSourceId:    string | null
  reshapeTargetId:    string | null
  reshapeCount:       number
  resolvedRunId:      string | null
}

// ── Selection scoring constants ─────────────────────────────────────────

export const PRIORITY_WEIGHTS: Record<Priority, number> = {
  P0: 10,
  P1: 6,
  P2: 3,
}

/** Opportunities older than this are excluded from the bank query. */
export const FRESHNESS_WINDOW_DAYS = 30

/** No more than this many of any single `type` in one daily run. */
export const DIVERSITY_CAP_PER_TYPE = 2

/** After this many reshape iterations on the same lineage, dismiss instead. */
export const RESHAPE_MAX_DEPTH = 3

/** Default size of the daily run's surface batch. Reduced from 7 to 5
 *  to keep the aggregator's LLM synthesis input bounded — 7 verbose
 *  approval-card riskReasons + specialist propose_actions was pushing
 *  context size enough to cause slow LLM responses + stall risk. */
export const DEFAULT_SURFACE_LIMIT = 5

/**
 * Per-type score multipliers applied on top of PRIORITY_WEIGHTS in
 * scoreAndPick. Unlisted types default to 1.0 (no boost).
 *
 * Article creation is the primary SEO growth lever for our tenants, so
 * blog post + landing page creation outrank other types within the same
 * priority tier. Math at 2.0x: a P1 blog (6 * 2 = 12) beats a P0 of any
 * other type (10), but a P2 blog (3 * 2 = 6) ties P1 of other types
 * (also 6) — so quality bar still matters.
 *
 * Update with care: raising the multiplier risks crowding out audit
 * fixes and outreach. 2.0x has been chosen as the smallest boost that
 * makes article creation dominant within tier without overrunning the
 * mix.
 */
export const TYPE_BOOSTS: Record<string, number> = {
  create_new_blog_post: 2.0,
  create_landing_page:  2.0,
}

/**
 * Per-type override of DIVERSITY_CAP_PER_TYPE. Unlisted types use the
 * default cap. We allow up to 3 article-creation slots per daily run
 * (versus the default 2) so a content-heavy bank can surface a real
 * editorial calendar, not just one piece.
 */
export const TYPE_DIVERSITY_CAPS: Record<string, number> = {
  create_new_blog_post: 3,
  create_landing_page:  3,
}

// ── Flat-rejection detection ────────────────────────────────────────────

/**
 * If a rejection_reason matches these (case-insensitive, short input), we
 * treat it as a "permanent dismiss" rather than substantive feedback.
 * Keep tight — false positives here mean the operator's feedback gets
 * thrown away. The length check guards against a long reason that happens
 * to contain "no".
 */
export const FLAT_REJECTION_KEYWORDS: readonly string[] = [
  'no', 'nope', 'never', 'stop', 'dismiss', 'cancel',
  'not relevant', 'wrong', 'irrelevant', 'kill', 'skip',
  'don\'t', 'do not', 'pass',
] as const

/** Rejections with `reason` shorter than this are eligible for flat-rejection
 *  keyword matching. Longer reasons are assumed substantive regardless. */
export const FLAT_REJECTION_MAX_LENGTH = 15

// ── Ad-hoc match types ──────────────────────────────────────────────────

export interface AdHocMatch {
  /** Opportunity types this prompt is likely asking about. */
  types:      string[]
  /** 0–1, 0 = no match, 1 = perfect match. Threshold at 0.7. */
  confidence: number
}

export const AD_HOC_CONFIDENCE_THRESHOLD = 0.7
