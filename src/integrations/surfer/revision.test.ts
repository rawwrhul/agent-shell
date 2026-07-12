import { describe, it, expect } from 'vitest'
import { extractScore, gateVerdict, extractAiVerdict, extractHumanizedText, DEFAULT_SCORE_THRESHOLD } from './revision'

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

describe('gateVerdict (autonomous publish hard gate)', () => {
  it('passes at exactly the threshold', () => {
    expect(gateVerdict(DEFAULT_SCORE_THRESHOLD, DEFAULT_SCORE_THRESHOLD)).toBe(true)
  })

  it('fails one point below the threshold', () => {
    expect(gateVerdict(DEFAULT_SCORE_THRESHOLD - 1, DEFAULT_SCORE_THRESHOLD)).toBe(false)
  })

  it('fails closed on a null score (Surfer gave nothing usable)', () => {
    expect(gateVerdict(null, DEFAULT_SCORE_THRESHOLD)).toBe(false)
  })
})

describe('extractAiVerdict', () => {
  it('reads a string verdict field', () => {
    expect(extractAiVerdict({ verdict: 'AI-generated' })).toBe(true)
    expect(extractAiVerdict({ result: 'human' })).toBe(false)
  })

  it('reads a 0-1 probability under an ai-ish key', () => {
    expect(extractAiVerdict({ ai_probability: 0.83 })).toBe(true)
    expect(extractAiVerdict({ ai_probability: 0.12 })).toBe(false)
  })

  it('reads a 0-100 percentage under a detect-ish key', () => {
    expect(extractAiVerdict({ detection_score: 91 })).toBe(true)
  })

  it('finds a verdict nested in an envelope', () => {
    expect(extractAiVerdict({ data: { classification: 'ai' } })).toBe(true)
  })

  it('returns null when nothing verdict-like exists', () => {
    expect(extractAiVerdict({ keyword: 'x' })).toBeNull()
    expect(extractAiVerdict(null)).toBeNull()
  })
})

describe('extractHumanizedText', () => {
  const original = 'x'.repeat(400)

  it('prefers a name-matched key', () => {
    const text = 'h'.repeat(300)
    expect(extractHumanizedText({ humanized: text, id: 'abc' }, original.length)).toBe(text)
  })

  it('finds text nested in an envelope', () => {
    const text = 'h'.repeat(300)
    expect(extractHumanizedText({ data: { content: text } }, original.length)).toBe(text)
  })

  it('rejects strings too short to plausibly be the rewrite', () => {
    expect(extractHumanizedText({ humanized: 'ok' }, original.length)).toBeNull()
  })

  it('returns null for empty/unusable responses', () => {
    expect(extractHumanizedText(null, original.length)).toBeNull()
    expect(extractHumanizedText({ status: 'queued' }, original.length)).toBeNull()
  })
})
