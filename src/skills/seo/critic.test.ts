import { describe, it, expect } from 'vitest'
import { parseCriticResponse } from './critic'

describe('parseCriticResponse', () => {
  it('parses a clean ship verdict', () => {
    const r = parseCriticResponse('{"verdict": "ship", "reason": "grounded in GSC data"}')
    expect(r).toEqual({ ship: true, reason: 'grounded in GSC data' })
  })

  it('parses a reject verdict wrapped in prose', () => {
    const r = parseCriticResponse('Here is my assessment:\n{"verdict": "reject", "reason": "no data cited"}\nDone.')
    expect(r).toEqual({ ship: false, reason: 'no data cited' })
  })

  it('is case-tolerant on the verdict', () => {
    expect(parseCriticResponse('{"verdict": "SHIP", "reason": "ok"}')?.ship).toBe(true)
  })

  it('returns null for unknown verdicts (caller fails open)', () => {
    expect(parseCriticResponse('{"verdict": "maybe", "reason": "hmm"}')).toBeNull()
  })

  it('returns null for non-JSON output (caller fails open)', () => {
    expect(parseCriticResponse('I think this is fine to ship.')).toBeNull()
    expect(parseCriticResponse('')).toBeNull()
  })

  it('truncates runaway reasons', () => {
    const r = parseCriticResponse(`{"verdict": "reject", "reason": "${'x'.repeat(1000)}"}`)
    expect(r?.reason.length).toBeLessThanOrEqual(400)
  })
})
