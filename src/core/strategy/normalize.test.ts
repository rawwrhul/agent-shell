// src/core/strategy/normalize.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeStrategyCore } from './normalize'

describe('normalizeStrategyCore', () => {
  it('returns an empty valid core for non-object input', () => {
    const { core, warnings } = normalizeStrategyCore(null)
    expect(core).toEqual({ portfolio: [], fronts: [], constraints: [] })
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('keeps a well-formed portfolio and renumbers priority 1..n in order', () => {
    const { core } = normalizeStrategyCore({
      portfolio: [
        { topic: 'B', disposition: 'attack', priority: 5, targetKeywords: ['k1', 'k2'] },
        { topic: 'A', disposition: 'grow',   priority: 2, targetKeywords: ['k3'] },
      ],
    })
    expect(core.portfolio.map(c => c.topic)).toEqual(['A', 'B'])
    expect(core.portfolio.map(c => c.priority)).toEqual([1, 2])
  })

  it('clamps unknown dispositions to grow and warns', () => {
    const { core, warnings } = normalizeStrategyCore({
      portfolio: [{ topic: 'X', disposition: 'dominate', priority: 1 }],
    })
    expect(core.portfolio[0].disposition).toBe('grow')
    expect(warnings.some(w => w.includes('disposition'))).toBe(true)
  })

  it('drops portfolio entries without a topic and dedupes case-insensitively', () => {
    const { core } = normalizeStrategyCore({
      portfolio: [
        { topic: 'Same', disposition: 'grow', priority: 1 },
        { topic: 'same', disposition: 'attack', priority: 2 },
        { disposition: 'grow', priority: 3 },
      ],
    })
    expect(core.portfolio).toHaveLength(1)
  })

  it('keeps only fronts with both competitor and where, coerces winnable to bool', () => {
    const { core } = normalizeStrategyCore({
      fronts: [
        { competitor: 'acme.com', where: 'pricing keywords', winnable: 1 },
        { competitor: 'only-competitor.com' },
        { where: 'orphan' },
      ],
    })
    expect(core.fronts).toHaveLength(1)
    expect(core.fronts[0].winnable).toBe(true)
  })

  it('defaults unknown constraint kinds to learning and drops empty values', () => {
    const { core } = normalizeStrategyCore({
      constraints: [
        { kind: 'no_go', value: 'no competitor comparisons' },
        { kind: 'wat',   value: 'mystery' },
        { kind: 'voice', value: '' },
      ],
    })
    expect(core.constraints).toHaveLength(2)
    expect(core.constraints[1].kind).toBe('learning')
  })

  it('truncates oversized arrays and long fields', () => {
    const portfolio = Array.from({ length: 60 }, (_, i) => ({ topic: `t${i}`, disposition: 'grow', priority: i + 1 }))
    const { core } = normalizeStrategyCore({ portfolio })
    expect(core.portfolio.length).toBeLessThanOrEqual(40)
    const longVal = 'x'.repeat(5000)
    const { core: c2 } = normalizeStrategyCore({ constraints: [{ kind: 'learning', value: longVal }] })
    expect(c2.constraints[0].value.length).toBeLessThanOrEqual(600)
  })
})
