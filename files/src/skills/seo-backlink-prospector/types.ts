// src/skills/seo-backlink-prospector/types.ts
//
// Shared types for the backlink prospector. Internal — not exported from
// the skill's index.

export interface InventoryBacklinkRow {
  sourceUrl:    string
  sourceDomain: string
  anchorText:   string | null
  sourceDr:     number | null
  dofollow:     boolean
}

export interface CompetitorBacklinkRow extends InventoryBacklinkRow {
  /** Which of our competitors this backlink points at. */
  competitorDomain: string
  /** The specific competitor URL being linked to. */
  competitorTargetUrl: string
}

/** A potential prospect — a competitor backlink we'd want for ourselves. */
export interface BacklinkProspect {
  sourceUrl:           string
  sourceDomain:        string
  sourceDr:            number | null
  anchorText:          string | null
  competitorDomain:    string
  competitorTargetUrl: string
  /** Computed: how strong a candidate is this? 1.0=excellent, 0.0=weak. */
  prospectScore:       number
  /** Reasoning string for the operator. */
  rationale:           string
}

export interface ProspectCycleResult {
  tenantId:                string
  inventoryFetched:        number
  inventoryNew:            number
  competitorsScanned:      number
  candidatesIdentified:    number
  candidatesAfterSafety:   number   // after canProspect() filtering
  opportunitiesFiled:      number
  draftsGenerated:         number
  errors:                  string[]
}

// ── Heuristics ──────────────────────────────────────────────────────────

/** Minimum domain rating worth pursuing. Filters out obvious spam links. */
export const MIN_PROSPECT_DR = 20

/** Maximum prospects to file per cycle. Keeps the bank from flooding. */
export const MAX_PROSPECTS_PER_CYCLE = 15

/** Skip referring domains we already have any link from — pursue NEW
 *  domains over more links from existing ones, for diversity. */
export const REQUIRE_NEW_DOMAIN = true
