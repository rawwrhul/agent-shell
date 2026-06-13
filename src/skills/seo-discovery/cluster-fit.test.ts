// src/skills/seo-discovery/cluster-fit.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildResolverFromCore, weightForDisposition, pickClusterFitKeyword,
  NEUTRAL_FIT, DISPOSITION_WEIGHTS,
} from './cluster-fit'
import type { StrategyCore } from '../../core/strategy/types'

const core: StrategyCore = {
  portfolio: [
    { topic: 'A', disposition: 'attack', priority: 1, targetKeywords: ['offshore accountant', 'offshore bookkeeper'] },
    { topic: 'B', disposition: 'grow',   priority: 2, targetKeywords: ['hire offshore staff'] },
    { topic: 'C', disposition: 'ignore', priority: 3, targetKeywords: ['cheap seo'] },
  ],
  fronts: [],
  constraints: [],
}

describe('weightForDisposition', () => {
  it('maps each disposition and treats null as neutral', () => {
    expect(weightForDisposition('attack')).toBe(DISPOSITION_WEIGHTS.attack)
    expect(weightForDisposition('ignore')).toBe(DISPOSITION_WEIGHTS.ignore)
    expect(weightForDisposition(null)).toBe(NEUTRAL_FIT)
  })
})

describe('buildResolverFromCore — containment matching', () => {
  const r = buildResolverFromCore(core)

  it('matches exact phrases case-insensitively', () => {
    expect(r.dispositionFor('Offshore Accountant')).toBe('attack')
    expect(r.fit('offshore accountant')).toBe(DISPOSITION_WEIGHTS.attack)
  })

  it('matches a portfolio phrase contained inside a longer real query', () => {
    expect(r.dispositionFor('hire offshore accountant australia')).toBe('attack')
    expect(r.dispositionFor('best offshore bookkeeper for smes')).toBe('attack')
    expect(r.fit('how to hire offshore staff in 2026')).toBe(DISPOSITION_WEIGHTS.grow)
  })

  it('does not match on partial-word overlap', () => {
    // "cheap seo" must not match "cheap season tickets"
    expect(r.dispositionFor('cheap season tickets')).toBeNull()
  })

  it('prefers the longest (most specific) matching phrase', () => {
    const core2: StrategyCore = {
      portfolio: [
        { topic: 'short', disposition: 'ignore', priority: 2, targetKeywords: ['offshore'] },
        { topic: 'long',  disposition: 'attack', priority: 1, targetKeywords: ['offshore accountant'] },
      ],
      fronts: [], constraints: [],
    }
    const r2 = buildResolverFromCore(core2)
    expect(r2.dispositionFor('hire offshore accountant now')).toBe('attack')
  })

  it('suppresses but does not zero ignored-cluster queries', () => {
    const w = r.fit('looking for cheap seo')
    expect(w).toBe(DISPOSITION_WEIGHTS.ignore)
    expect(w).toBeGreaterThan(0)
  })

  it('returns neutral for queries that map nowhere, including bare tokens', () => {
    expect(r.dispositionFor('offshore')).toBeNull() // no portfolio phrase fits inside "offshore"
    expect(r.fit('offshore')).toBe(NEUTRAL_FIT)
    expect(r.fit('something unrelated')).toBe(NEUTRAL_FIT)
    expect(r.fit(undefined)).toBe(NEUTRAL_FIT)
  })

  it('is all-neutral when there is no strategy core', () => {
    const empty = buildResolverFromCore(null)
    expect(empty.fit('hire offshore accountant australia')).toBe(NEUTRAL_FIT)
  })
})

describe('pickClusterFitKeyword', () => {
  const r = buildResolverFromCore(core)

  it('credits the highest-weight query that maps to a real cluster', () => {
    const got = pickClusterFitKeyword(r, [
      { keyword: 'offshore', weight: 100 },                 // maps nowhere (highest weight)
      { keyword: 'hire offshore accountant', weight: 40 },  // attack
      { keyword: 'hire offshore staff today', weight: 10 }, // grow
    ])
    expect(got).toBe('hire offshore accountant')
  })

  it('falls back to highest-weight overall when none map', () => {
    const got = pickClusterFitKeyword(r, [
      { keyword: 'offshore', weight: 100 },
      { keyword: 'random thing', weight: 5 },
    ])
    expect(got).toBe('offshore')
  })

  it('returns undefined for an empty set', () => {
    expect(pickClusterFitKeyword(r, [])).toBeUndefined()
  })
})

import { blendClusterFit, keywordInPhrases } from './cluster-fit'

describe('blendClusterFit', () => {
  const r = buildResolverFromCore(core)

  it('EV-weights across mapped queries instead of winner-take-all', () => {
    // "offshore accountant" → attack(1.3), "cheap seo" → ignore(0.25)
    const blendEqual = blendClusterFit(r, [
      { keyword: 'offshore accountant', weight: 10 },
      { keyword: 'cheap seo', weight: 10 },
    ])
    expect(blendEqual).toBeCloseTo((DISPOSITION_WEIGHTS.attack + DISPOSITION_WEIGHTS.ignore) / 2, 5)
    // A page dominated (by EV) by the attack query lands near attack, not ignore.
    const blendAttackHeavy = blendClusterFit(r, [
      { keyword: 'offshore accountant', weight: 90 },
      { keyword: 'cheap seo', weight: 10 },
    ])
    expect(blendAttackHeavy).toBeGreaterThan(1.0)
    expect(blendAttackHeavy).toBeLessThan(DISPOSITION_WEIGHTS.attack)
  })

  it('ignores unmapped queries and returns neutral when none map', () => {
    const blended = blendClusterFit(r, [
      { keyword: 'offshore accountant', weight: 5 },
      { keyword: 'totally unrelated thing', weight: 1000 }, // unmapped, excluded
    ])
    expect(blended).toBe(DISPOSITION_WEIGHTS.attack) // only the mapped query counts
    expect(blendClusterFit(r, [{ keyword: 'totally unrelated thing', weight: 1 }])).toBe(NEUTRAL_FIT)
    expect(blendClusterFit(r, [])).toBe(NEUTRAL_FIT)
  })
})

describe('keywordInPhrases', () => {
  it('matches whole-phrase containment, rejects partial-word overlap', () => {
    expect(keywordInPhrases('hire offshore accountant australia', ['offshore accountant'])).toBe(true)
    expect(keywordInPhrases('cheap season tickets', ['cheap seo'])).toBe(false)
    expect(keywordInPhrases('anything', [])).toBe(false)
  })
})
