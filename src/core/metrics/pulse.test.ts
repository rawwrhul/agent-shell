import { describe, it, expect, vi } from 'vitest'

vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { buildPerformancePulse } from './pulse'

function poolReturning(row: Record<string, unknown> | null) {
  return { query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }) } as never
}

describe('buildPerformancePulse', () => {
  it('formats clicks, impressions, position delta and top mover', async () => {
    const pulse = await buildPerformancePulse(poolReturning({
      clicks: 412, pclicks: 378, impressions: 38_100, pimpr: 36_600,
      pos: 12.3, ppos: 12.7,
      mover_url: 'https://tarino.au/resources/offshore-guide', mover_delta: 31,
    }), 'tarino')
    expect(pulse).toContain('412 clicks (+9%)')
    expect(pulse).toContain('38.1K impressions (+4%)')
    expect(pulse).toContain('avg pos 12.3 (▲0.4)')
    expect(pulse).toContain('/resources/offshore-guide +31 clicks')
  })

  it('returns null when no history exists', async () => {
    expect(await buildPerformancePulse(poolReturning({
      clicks: 0, pclicks: 0, impressions: 0, pimpr: 0, pos: null, ppos: null,
      mover_url: null, mover_delta: null,
    }), 't')).toBeNull()
    expect(await buildPerformancePulse(poolReturning(null), 't')).toBeNull()
  })

  it('handles new-tenant zero-baseline without divide-by-zero', async () => {
    const pulse = await buildPerformancePulse(poolReturning({
      clicks: 50, pclicks: 0, impressions: 900, pimpr: 0,
      pos: 18.0, ppos: null, mover_url: null, mover_delta: null,
    }), 't')
    expect(pulse).toContain('50 clicks (new)')
  })

  it('returns null instead of throwing on DB errors', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) } as never
    expect(await buildPerformancePulse(pool, 't')).toBeNull()
  })

  it('omits small movers below the 3-click threshold', async () => {
    const pulse = await buildPerformancePulse(poolReturning({
      clicks: 100, pclicks: 100, impressions: 1000, pimpr: 1000,
      pos: 10.0, ppos: 10.0, mover_url: 'https://x.com/page', mover_delta: 1,
    }), 't')
    expect(pulse).not.toContain('top mover')
  })
})
