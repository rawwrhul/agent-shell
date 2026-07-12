import { describe, it, expect } from 'vitest'
import { normalizeTitleTokens, titleSimilarity } from './cannibalization'

describe('normalizeTitleTokens', () => {
  it('lowercases, strips punctuation and stopwords', () => {
    const tokens = normalizeTitleTokens('The Ultimate Guide to Offshore Teams (2026)')
    expect(tokens).toEqual(new Set(['offshore', 'teams']))
  })

  it('drops single-character noise', () => {
    const tokens = normalizeTitleTokens('A B testing & CRO basics')
    expect(tokens.has('b')).toBe(false)
    expect(tokens.has('testing')).toBe(true)
  })
})

describe('titleSimilarity', () => {
  it('flags reworded duplicates of the same topic', () => {
    const sim = titleSimilarity(
      'The Complete Guide to Offshore Development Teams',
      'Offshore Development Teams: A Guide for 2026',
    )
    expect(sim).toBeGreaterThanOrEqual(0.6)
  })

  it('passes genuinely different topics', () => {
    const sim = titleSimilarity(
      'How to Run Payroll for Offshore Staff in the Philippines',
      'Customer Support Metrics Every SaaS Team Should Track',
    )
    expect(sim).toBeLessThan(0.3)
  })

  it('shared modifier words alone do not trigger it', () => {
    const sim = titleSimilarity(
      'Hiring Offshore Accountants: Costs and Process',
      'Hiring In-House Designers: Costs and Process',
    )
    expect(sim).toBeLessThan(0.6)
  })

  it('returns 0 for empty or stopword-only titles', () => {
    expect(titleSimilarity('', 'Offshore Teams')).toBe(0)
    expect(titleSimilarity('The A An', 'Offshore Teams')).toBe(0)
  })
})
