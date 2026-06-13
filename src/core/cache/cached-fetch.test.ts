import { describe, it, expect, vi } from 'vitest'

vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { cachedJson } from './cached-fetch'

function mockPool(hitPayload: unknown | null) {
  const query = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT payload')) {
      return Promise.resolve({ rows: hitPayload === null ? [] : [{ payload: hitPayload }] })
    }
    return Promise.resolve({ rows: [] })
  })
  return { pool: { query } as never, query }
}

describe('cachedJson', () => {
  it('returns cached payload without calling fetcher on hit', async () => {
    const { pool } = mockPool({ dr: 71 })
    const fetcher = vi.fn()
    const r = await cachedJson({ pool, source: 'ahrefs', key: 'dr:x.com', tenantId: 't1', ttlSeconds: 60, fetcher })
    expect(r.cacheHit).toBe(true)
    expect(r.value).toEqual({ dr: 71 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('calls fetcher and writes through on miss', async () => {
    const { pool, query } = mockPool(null)
    const fetcher = vi.fn().mockResolvedValue({ dr: 42 })
    const r = await cachedJson({ pool, source: 'ahrefs', key: 'dr:y.com', tenantId: 't1', ttlSeconds: 60, fetcher })
    expect(r.cacheHit).toBe(false)
    expect(r.value).toEqual({ dr: 42 })
    expect(fetcher).toHaveBeenCalledOnce()
    const inserts = query.mock.calls.filter(c => String(c[0]).includes('INSERT INTO cache_entries'))
    expect(inserts.length).toBe(1)
  })

  it('still returns the fetched value when cache read AND write fail', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) } as never
    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    const r = await cachedJson({ pool, source: 'surfer', key: 'g:k', tenantId: 't1', ttlSeconds: 60, fetcher })
    expect(r.cacheHit).toBe(false)
    expect(r.value).toEqual({ ok: true })
  })

  it('scopes by tenant in the read query', async () => {
    const { pool, query } = mockPool(null)
    await cachedJson({ pool, source: 'ahrefs', key: 'k', tenantId: 'tenant-a', ttlSeconds: 60, fetcher: async () => ({}) })
    const read = query.mock.calls.find(c => String(c[0]).includes('SELECT payload'))
    expect(read?.[1]).toContain('tenant-a')
  })
})
