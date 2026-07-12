// src/skills/seo-outcomes/scoring.ts
//
// Pure, deterministic outcome verdicts for shipped actions. No LLM anywhere
// in this module — numbers in, verdict out (deterministic calculators over
// LLM-generated numbers, per platform principle).
//
// The comparison is a diff-in-diff-lite: the target page's before→after
// click ratio is compared against the rest of the site's ratio over the
// same windows (the "control"), so a site-wide lift (seasonality, algorithm
// update) doesn't get credited to one meta rewrite.

export interface WindowMetrics {
  clicks:      number
  impressions: number
  /** Impression-weighted average position; null when no impressions. */
  position:    number | null
}

export interface OutcomeInput {
  pageBefore:    WindowMetrics
  pageAfter:     WindowMetrics
  controlBefore: WindowMetrics
  controlAfter:  WindowMetrics
  /** approve_blog_pitch / create_and_publish — page didn't exist before. */
  isNewPage:     boolean
}

export type OutcomeVerdict = 'win' | 'loss' | 'neutral'

export interface OutcomeScore {
  verdict: OutcomeVerdict
  /** One-line deterministic explanation used in the memory value. */
  reason:  string
  /** Relative click lift vs control, when computable. */
  liftPct?: number
  positionDelta?: number
}

// Thresholds. Deliberately conservative: a memory row labelled 'win' becomes
// agent policy, so false positives are worse than neutrals.
const MIN_CLICKS_FOR_CLICK_VERDICT = 10   // combined before+after
const WIN_LIFT   =  0.25                  // +25% vs control
const LOSS_LIFT  = -0.20                  // -20% vs control
const POS_DELTA  =  2                     // avg position spots
const NEW_PAGE_WIN_CLICKS      = 5
const NEW_PAGE_WIN_IMPRESSIONS = 200
const NEW_PAGE_LOSS_IMPRESSIONS = 20

export function scoreOutcome(input: OutcomeInput): OutcomeScore {
  const { pageBefore, pageAfter, controlBefore, controlAfter, isNewPage } = input

  if (isNewPage) {
    if (pageAfter.clicks >= NEW_PAGE_WIN_CLICKS) {
      return { verdict: 'win', reason: `new page earned ${pageAfter.clicks} clicks in the window` }
    }
    if (pageAfter.impressions >= NEW_PAGE_WIN_IMPRESSIONS) {
      return { verdict: 'win', reason: `new page visible: ${pageAfter.impressions} impressions (clicks still ramping)` }
    }
    if (pageAfter.impressions < NEW_PAGE_LOSS_IMPRESSIONS) {
      return { verdict: 'loss', reason: `new page near-invisible: ${pageAfter.impressions} impressions — wrong topic, not indexed, or no demand` }
    }
    return { verdict: 'neutral', reason: `new page at ${pageAfter.impressions} impressions / ${pageAfter.clicks} clicks — too early to call` }
  }

  // Click-based verdict when there's enough volume to mean something.
  if (pageBefore.clicks + pageAfter.clicks >= MIN_CLICKS_FOR_CLICK_VERDICT) {
    const pageRatio    = pageAfter.clicks    / Math.max(pageBefore.clicks, 1)
    const controlRatio = controlAfter.clicks / Math.max(controlBefore.clicks, 1)
    if (controlRatio > 0) {
      const lift = pageRatio / controlRatio - 1
      const liftPct = Math.round(lift * 100)
      if (lift >= WIN_LIFT) {
        return { verdict: 'win', liftPct, reason: `clicks ${pageBefore.clicks}→${pageAfter.clicks}, ${liftPct >= 0 ? '+' : ''}${liftPct}% vs site control` }
      }
      if (lift <= LOSS_LIFT) {
        return { verdict: 'loss', liftPct, reason: `clicks ${pageBefore.clicks}→${pageAfter.clicks}, ${liftPct}% vs site control` }
      }
      // Between thresholds → try position before settling on neutral.
      const pos = positionVerdict(pageBefore, pageAfter)
      if (pos) return { ...pos, liftPct }
      return { verdict: 'neutral', liftPct, reason: `clicks ${pageBefore.clicks}→${pageAfter.clicks} (${liftPct >= 0 ? '+' : ''}${liftPct}% vs control) — within noise` }
    }
  }

  // Low click volume → position is the more sensitive instrument.
  const pos = positionVerdict(pageBefore, pageAfter)
  if (pos) return pos

  return {
    verdict: 'neutral',
    reason: `insufficient signal (${pageBefore.clicks}+${pageAfter.clicks} clicks, position ${fmtPos(pageBefore.position)}→${fmtPos(pageAfter.position)})`,
  }
}

function positionVerdict(before: WindowMetrics, after: WindowMetrics): OutcomeScore | null {
  if (before.position === null || after.position === null) return null
  const delta = before.position - after.position   // positive = improved
  const rounded = Math.round(delta * 10) / 10
  if (delta >= POS_DELTA) {
    return { verdict: 'win', positionDelta: rounded, reason: `avg position ${fmtPos(before.position)}→${fmtPos(after.position)} (improved ${rounded})` }
  }
  if (delta <= -POS_DELTA) {
    return { verdict: 'loss', positionDelta: rounded, reason: `avg position ${fmtPos(before.position)}→${fmtPos(after.position)} (dropped ${Math.abs(rounded)})` }
  }
  return null
}

function fmtPos(p: number | null): string {
  return p === null ? '–' : (Math.round(p * 10) / 10).toFixed(1)
}
