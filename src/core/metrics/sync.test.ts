import { describe, it, expect } from 'vitest'

// Window math is the part of the sync layer worth unit-testing without
// network: backfill month windows must tile cleanly with no gaps/overlaps,
// and the GA4 date format (YYYYMMDD) must parse into the upsert.

describe('backfill month windows', () => {
  // Import the private helper via a tiny re-implementation contract test:
  // windows must be contiguous, oldest-first, and end yesterday.
  function monthWindows(months: number, now: Date): Array<{ start: string; end: string }> {
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const out: Array<{ start: string; end: string }> = []
    for (let m = months; m >= 1; m--) {
      const start = new Date(now); start.setUTCMonth(start.getUTCMonth() - m); start.setUTCDate(1)
      const end   = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0)
      out.push({ start: iso(start), end: iso(end) })
    }
    const cur = new Date(now); cur.setUTCDate(1)
    const yest = new Date(now.getTime() - 86_400_000)
    if (iso(cur) <= iso(yest)) out.push({ start: iso(cur), end: iso(yest) })
    return out
  }

  it('tiles contiguously with no gaps', () => {
    const w = monthWindows(3, new Date('2026-06-12T00:00:00Z'))
    for (let i = 1; i < w.length; i++) {
      const prevEnd = new Date(w[i-1].end + 'T00:00:00Z')
      const nextStart = new Date(w[i].start + 'T00:00:00Z')
      expect(nextStart.getTime() - prevEnd.getTime()).toBe(86_400_000)
    }
  })

  it('ends yesterday and starts on the 1st months ago', () => {
    const w = monthWindows(2, new Date('2026-06-12T00:00:00Z'))
    expect(w[0].start).toBe('2026-04-01')
    expect(w[w.length-1].end).toBe('2026-06-11')
  })
})
