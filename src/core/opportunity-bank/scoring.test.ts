// src/core/opportunity-bank/scoring.test.ts
import { describe, it, expect } from 'vitest'
import {
  ctrAtPosition, evStrikingDistance, evDecayRecovery, scoreOpportunity,
  priorityFromScore, defaultScoreForPriority, DEFAULT_SCORE_FOR_PRIORITY,
  PRIORITY_BANDS, WEEKS_FLOOR,
} from './scoring'

describe('ctrAtPosition', () => {
  it('is monotonically non-increasing across positions 1..25', () => {
    let prev = Infinity
    for (let p = 1; p <= 25; p++) {
      const c = ctrAtPosition(p)
      expect(c).toBeLessThanOrEqual(prev + 1e-9)
      expect(c).toBeGreaterThan(0)
      prev = c
    }
  })
  it('clamps invalid/<1 positions to position 1', () => {
    expect(ctrAtPosition(0)).toBe(ctrAtPosition(1))
    expect(ctrAtPosition(-5)).toBe(ctrAtPosition(1))
    expect(ctrAtPosition(NaN)).toBe(ctrAtPosition(1))
  })
})

describe('evStrikingDistance', () => {
  it('is positive when the page can move up, zero when already at/above target', () => {
    expect(evStrikingDistance({ impressions: 10_000, currentPosition: 7, targetPosition: 3 })).toBeGreaterThan(0)
    expect(evStrikingDistance({ impressions: 10_000, currentPosition: 2, targetPosition: 3 })).toBe(0)
  })
  it('scales with impressions', () => {
    const a = evStrikingDistance({ impressions: 1_000, currentPosition: 8, targetPosition: 3 })
    const b = evStrikingDistance({ impressions: 2_000, currentPosition: 8, targetPosition: 3 })
    expect(b).toBeCloseTo(a * 2, 5)
  })
})

describe('evDecayRecovery', () => {
  it('is the recoverable click gap, floored at 0', () => {
    expect(evDecayRecovery({ clicksPeak: 500, clicksNow: 200 })).toBe(300)
    expect(evDecayRecovery({ clicksPeak: 100, clicksNow: 140 })).toBe(0)
  })
})

describe('scoreOpportunity', () => {
  it('uses conversions when pageConvRate > 0, clicks otherwise', () => {
    const conv = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, pageConvRate: 0.05 })
    expect(conv.currency).toBe('conversions')
    expect(conv.evMonthlyConversions).toBeCloseTo(5, 6)

    const clk = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, pageConvRate: 0 })
    expect(clk.currency).toBe('clicks')
    expect(clk.evMonthlyConversions).toBeNull()

    const nullRate = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, pageConvRate: null })
    expect(nullRate.currency).toBe('clicks')
  })

  it('floors weeks_to_impact so the divisor never explodes', () => {
    const r = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, weeksToImpact: 0, probability: 1, clusterFit: 1 })
    expect(r.weeksToImpact).toBe(WEEKS_FLOOR)
    expect(Number.isFinite(r.score)).toBe(true)
  })

  it('ranks a faster win above an equal-magnitude slower one', () => {
    const fast = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, weeksToImpact: 2, probability: 1, clusterFit: 1, pageConvRate: 0 })
    const slow = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, weeksToImpact: 8, probability: 1, clusterFit: 1, pageConvRate: 0 })
    expect(fast.score).toBeGreaterThan(slow.score)
  })

  it('lets a big slow win beat a small fast win when magnitude dominates', () => {
    const bigSlow   = scoreOpportunity({ action: 'article_create', evMonthlyClicks: 1000, weeksToImpact: 10, probability: 1, clusterFit: 1, pageConvRate: 0 })
    const smallFast = scoreOpportunity({ action: 'metadata_edit',  evMonthlyClicks: 20,   weeksToImpact: 2,  probability: 1, clusterFit: 1, pageConvRate: 0 })
    expect(bigSlow.score).toBeGreaterThan(smallFast.score)
  })

  it('folds probability and clusterFit into expected change, not as separate score terms', () => {
    const full = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, weeksToImpact: 1, probability: 1,   clusterFit: 1,   pageConvRate: 0 })
    const half = scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, weeksToImpact: 1, probability: 0.5, clusterFit: 1,   pageConvRate: 0 })
    const boost= scoreOpportunity({ action: 'metadata_edit', evMonthlyClicks: 100, weeksToImpact: 1, probability: 1,   clusterFit: 2,   pageConvRate: 0 })
    expect(half.score).toBeCloseTo(full.score * 0.5, 6)
    expect(boost.score).toBeCloseTo(full.score * 2, 6)
  })

  it('records an auditable score_inputs breakdown', () => {
    const r = scoreOpportunity({ action: 'copy_optimise', evMonthlyClicks: 50, pageConvRate: 0.04 })
    expect(r.scoreInputs).toMatchObject({ action: 'copy_optimise', currency: 'conversions', evMonthlyClicks: 50 })
  })
})

describe('priority banding', () => {
  it('round-trips legacy default scores back to their priority band', () => {
    expect(priorityFromScore(DEFAULT_SCORE_FOR_PRIORITY.P0)).toBe('P0')
    expect(priorityFromScore(DEFAULT_SCORE_FOR_PRIORITY.P1)).toBe('P1')
    expect(priorityFromScore(DEFAULT_SCORE_FOR_PRIORITY.P2)).toBe('P2')
  })
  it('bands by threshold and defaults unknown priorities to P2', () => {
    expect(priorityFromScore(PRIORITY_BANDS.P0)).toBe('P0')
    expect(priorityFromScore(PRIORITY_BANDS.P1)).toBe('P1')
    expect(priorityFromScore(0)).toBe('P2')
    expect(priorityFromScore(NaN)).toBe('P2')
    expect(defaultScoreForPriority('garbage')).toBe(DEFAULT_SCORE_FOR_PRIORITY.P2)
  })
})
