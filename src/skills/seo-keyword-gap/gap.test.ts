// src/skills/seo-keyword-gap/gap.test.ts
import { describe, it, expect } from 'vitest'
import { mapAhrefsOrganicRows, diffGap, buildGapSecondaryResolver, domainTokens } from './gap'
import type { CompetitorKeywordRow } from './gap'
import type { StrategyCore } from '../../core/strategy/types'

describe('mapAhrefsOrganicRows', () => {
  it('parses the { keywords: [...] } payload shape', () => {
    const rows = mapAhrefsOrganicRows({
      keywords: [
        { keyword: 'Level 2 Electrician Sydney', best_position: 3, volume: 900, keyword_difficulty: 12, best_position_url: 'https://x.com/a' },
        { keyword: 'ev charger install', best_position: 18, volume: 250, keyword_difficulty: null, best_position_url: null },
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ keyword: 'level 2 electrician sydney', position: 3, volume: 900, difficulty: 12, url: 'https://x.com/a' })
    expect(rows[1].difficulty).toBeNull()
  })

  it('parses a top-level array and skips malformed rows', () => {
    const rows = mapAhrefsOrganicRows([
      { keyword: 'ok', best_position: 5, volume: 10 },
      { keyword: '', best_position: 5 },
      { best_position: 5 },
      { keyword: 'no position' },
      { keyword: 'zero pos', best_position: 0 },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].keyword).toBe('ok')
  })

  it('returns [] on junk payloads', () => {
    expect(mapAhrefsOrganicRows(null)).toEqual([])
    expect(mapAhrefsOrganicRows({ nope: 1 })).toEqual([])
    expect(mapAhrefsOrganicRows('x')).toEqual([])
  })
})

describe('diffGap', () => {
  const mk = (keyword: string, position: number, volume: number, url: string | null = null): CompetitorKeywordRow =>
    ({ keyword, position, volume, difficulty: null, url })

  const base = {
    ourKeywords: new Set(['switchboard upgrade sydney']),
    brandTokens: ['highdemand', 'hdlevel2electriciansydney'],
    maxPosition: 20,
    minVolume: 10,
  }

  it('keeps keywords a competitor ranks for that we do not', () => {
    const gaps = diffGap({
      ...base,
      competitorRows: new Map([['gordonpowers.com.au', [mk('private power pole cost', 4, 400, 'https://g.com/p')]]]),
    })
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ keyword: 'private power pole cost', bestCompetitorPos: 4, competitorDomains: ['gordonpowers.com.au'], competitorUrl: 'https://g.com/p' })
  })

  it('excludes keywords we already rank for, low volume, deep positions, our brand, and their brand', () => {
    const gaps = diffGap({
      ...base,
      competitorRows: new Map([['gordonpowers.com.au', [
        mk('switchboard upgrade sydney', 3, 500),      // ours already
        mk('tiny term', 3, 5),                          // below volume floor
        mk('page two term', 45, 900),                   // competitor too deep
        mk('highdemand electrical reviews', 1, 100),    // our brand
        mk('gordonpowers emergency', 1, 100),           // their brand
      ]]]),
    })
    expect(gaps).toHaveLength(0)
  })

  it('aggregates across competitors: best position wins, domains accumulate, sorted by volume', () => {
    const gaps = diffGap({
      ...base,
      competitorRows: new Map([
        ['a.com.au', [mk('shared term', 9, 100, 'https://a.com/x'), mk('big term', 15, 800)]],
        ['b.com.au', [mk('shared term', 4, 100, 'https://b.com/y')]],
      ]),
    })
    expect(gaps.map((g) => g.keyword)).toEqual(['big term', 'shared term'])
    const shared = gaps[1]
    expect(shared.bestCompetitorPos).toBe(4)
    expect(shared.competitorUrl).toBe('https://b.com/y')
    expect(shared.competitorDomains.sort()).toEqual(['a.com.au', 'b.com.au'])
  })
})

describe('domainTokens', () => {
  it('extracts the SLD as a brand token', () => {
    expect(domainTokens('gordonpowers.com.au')).toEqual(['gordonpowers'])
    expect(domainTokens('https://www.example.com/path')).toEqual(['example'])
  })
})

describe('buildGapSecondaryResolver', () => {
  const core = {
    portfolio: [
      { topic: 'EV Charging', disposition: 'attack', priority: 1, targetKeywords: ['ev charger', 'ev charging'], rationale: '' },
      { topic: 'Power Poles', disposition: 'grow', priority: 2, targetKeywords: ['power pole'], rationale: '' },
    ],
    fronts: [], constraints: [],
  } as unknown as StrategyCore

  const gaps = [
    { keyword: 'ev charger rebate nsw', volume: 300, difficulty: null, bestCompetitorPos: 6, competitorDomains: ['a.com'], competitorUrl: null },
    { keyword: 'best ev charger sydney', volume: 900, difficulty: null, bestCompetitorPos: 3, competitorDomains: ['b.com'], competitorUrl: null },
    { keyword: 'private power pole replacement', volume: 150, difficulty: null, bestCompetitorPos: 8, competitorDomains: ['a.com'], competitorUrl: null },
    { keyword: 'unrelated plumbing thing', volume: 999, difficulty: null, bestCompetitorPos: 2, competitorDomains: ['c.com'], competitorUrl: null },
  ]

  it('returns same-cluster gap keywords sorted by volume, excluding the query itself', () => {
    const r = buildGapSecondaryResolver(core, gaps)
    const out = r.gapKeywordsFor('ev charger installation cost')
    expect(out.map((g) => g.keyword)).toEqual(['best ev charger sydney', 'ev charger rebate nsw'])
  })

  it('respects the limit and returns [] for unmapped or empty keywords', () => {
    const r = buildGapSecondaryResolver(core, gaps)
    expect(r.gapKeywordsFor('ev charger installation cost', 1)).toHaveLength(1)
    expect(r.gapKeywordsFor('roof plumbing quote')).toEqual([])
    expect(r.gapKeywordsFor(undefined)).toEqual([])
    expect(r.gapKeywordsFor(null)).toEqual([])
  })

  it('is empty-safe with no strategy core', () => {
    const r = buildGapSecondaryResolver(null, gaps)
    expect(r.gapKeywordsFor('ev charger installation cost')).toEqual([])
  })
})
