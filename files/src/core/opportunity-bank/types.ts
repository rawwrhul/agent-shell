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

/** Default size of the daily run's surface batch. */
export const DEFAULT_SURFACE_LIMIT = 7

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
