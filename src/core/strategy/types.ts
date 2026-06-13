// src/core/strategy/types.ts
//
// Phase 2, build unit 2: the per-tenant strategy doc.
//
// Two layers in one artifact:
//   - StrategyCore  — machine-read by discovery cycles + scoring (portfolio
//                     dispositions feed cluster-fit; fronts + constraints scope
//                     and gate discovery).
//   - brief (prose) — read by the LLM daily/weekly run as steering context and
//                     by the operator to sanity-check.

export type ClusterDisposition = 'defend' | 'grow' | 'attack' | 'seed' | 'ignore'

export const CLUSTER_DISPOSITIONS: readonly ClusterDisposition[] =
  ['defend', 'grow', 'attack', 'seed', 'ignore'] as const

export interface PortfolioCluster {
  topic:           string
  disposition:     ClusterDisposition
  priority:        number          // 1 = highest
  targetKeywords:  string[]
  rationale?:      string
}

export interface CompetitiveFront {
  competitor: string
  where:      string               // the keyword/content axis they outrank us on
  winnable:   boolean
  note?:      string
}

export interface StrategyConstraint {
  kind:  'voice' | 'no_go' | 'decision' | 'learning'
  value: string
}

export interface StrategyCore {
  portfolio:   PortfolioCluster[]
  fronts:      CompetitiveFront[]
  constraints: StrategyConstraint[]
}

export interface StrategyDoc {
  tenantId:    string
  version:     number
  core:        StrategyCore
  brief:       string
  coldStart:   boolean
  generatedAt: string              // ISO
}

/**
 * Effective fortnightly cadence without cron gymnastics: the cron fires
 * weekly, but the cycle no-ops if the latest doc is younger than this unless
 * forced (CLI / onboarding bootstrap). Tunable.
 */
export const STRATEGY_MIN_AGE_DAYS = 12

// Defensive caps so a runaway LLM response can't bloat the stored doc.
export const MAX_PORTFOLIO_CLUSTERS = 40
export const MAX_TARGET_KEYWORDS    = 25
export const MAX_FRONTS             = 25
export const MAX_CONSTRAINTS        = 40
export const MAX_FIELD_CHARS        = 600
