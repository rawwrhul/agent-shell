import { describe, it, expect } from 'vitest'
import type { Pool } from 'pg'
import { isSilentTenant, SILENT_ANCHOR_TS } from './silence'

const fakePool = (autonomy: string | null): Pool => ({
  query: async () => ({ rows: [{ autonomy_level: autonomy }] }),
} as unknown as Pool)

const failingPool = (): Pool => ({
  query: async () => { throw new Error('db down') },
} as unknown as Pool)

describe('isSilentTenant', () => {
  it('silent only at autonomy_level=full', async () => {
    expect(await isSilentTenant(fakePool('full'), 't-full')).toBe(true)
    expect(await isSilentTenant(fakePool('hitl'), 't-hitl')).toBe(false)
    expect(await isSilentTenant(fakePool(null), 't-null')).toBe(false)
  })

  it('fails open (posts) when the lookup errors', async () => {
    expect(await isSilentTenant(failingPool(), 't-err')).toBe(false)
  })

  it('caches per tenant', async () => {
    let calls = 0
    const countingPool = {
      query: async () => { calls++; return { rows: [{ autonomy_level: 'full' }] } },
    } as unknown as Pool
    await isSilentTenant(countingPool, 't-cache')
    await isSilentTenant(countingPool, 't-cache')
    expect(calls).toBe(1)
  })
})

describe('SILENT_ANCHOR_TS', () => {
  it('is a stable non-Slack-shaped placeholder', () => {
    expect(SILENT_ANCHOR_TS).toBe('_silent_')
  })
})
