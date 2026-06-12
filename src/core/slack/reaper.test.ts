import { describe, it, expect, vi, beforeEach } from 'vitest'

const failRunMock = vi.fn().mockResolvedValue(undefined)
vi.mock('./index', () => ({ presenter: { failRun: (...args: unknown[]) => failRunMock(...args) } }))
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { reapStrandedRuns } from './reaper'

function poolWith(rows: unknown[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as never
}

describe('reapStrandedRuns', () => {
  beforeEach(() => failRunMock.mockClear())

  it('does nothing when no stranded runs exist', async () => {
    const reaped = await reapStrandedRuns(poolWith([]))
    expect(reaped).toBe(0)
    expect(failRunMock).not.toHaveBeenCalled()
  })

  it('fails each stranded run via the presenter', async () => {
    const rows = [
      { task_id: 't1', tenant_id: 'tarino', phase: 'running', updated_at: new Date() },
      { task_id: 't2', tenant_id: 'hd',     phase: 'planning', updated_at: new Date() },
    ]
    const reaped = await reapStrandedRuns(poolWith(rows))
    expect(reaped).toBe(2)
    expect(failRunMock).toHaveBeenCalledTimes(2)
    expect(failRunMock.mock.calls[0][0]).toBe('t1')
    expect(String(failRunMock.mock.calls[0][1])).toContain('orphaned')
  })

  it('continues the sweep when one failRun throws', async () => {
    failRunMock.mockRejectedValueOnce(new Error('channel_not_found'))
    const rows = [
      { task_id: 't1', tenant_id: 'tarino', phase: 'running', updated_at: new Date() },
      { task_id: 't2', tenant_id: 'hd',     phase: 'running', updated_at: new Date() },
    ]
    const reaped = await reapStrandedRuns(poolWith(rows))
    expect(reaped).toBe(1)
    expect(failRunMock).toHaveBeenCalledTimes(2)
  })

  it('returns 0 and survives when the query itself fails', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) } as never
    const reaped = await reapStrandedRuns(pool)
    expect(reaped).toBe(0)
  })
})
