import { describe, it, expect } from 'vitest'
import { extractScore } from './revision'

describe('extractScore', () => {
  it('reads a top-level content_score', () => {
    expect(extractScore({ content_score: 82 })).toBe(82)
  })

  it('prefers content_score over a generic score', () => {
    expect(extractScore({ score: 40, content_score: 77 })).toBe(77)
  })

  it('coerces numeric strings and rounds', () => {
    expect(extractScore({ contentScore: '68.6' })).toBe(69)
  })

  it('finds a score nested under a result/data envelope', () => {
    expect(extractScore({ result: { overall_score: 91 } })).toBe(91)
  })

  it('rejects out-of-range values (not a 0–100 score)', () => {
    expect(extractScore({ wordCountScore: 4200 })).toBeNull()
  })

  it('returns null when no score-like field exists', () => {
    expect(extractScore({ keyword: 'x', terms: ['a', 'b'] })).toBeNull()
  })

  it('returns null for non-objects', () => {
    expect(extractScore(null)).toBeNull()
    expect(extractScore('82')).toBeNull()
  })
})
