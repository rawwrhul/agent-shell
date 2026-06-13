// Cross-tenant isolation eval for Phase 4 Lever 3 semantic recall.
//
// The risk this feature introduces: agent_learnings is a NEW shared-table read
// path, and a recall run for tenant A must never surface tenant B's learnings.
// The single point of enforcement is the `tenant_id=$2` filter in
// retrieveRelevant's query. This eval proves, adversarially, that:
//   1. seeded with BOTH tenants' rows, a tenant-A query returns only A's, and
//   2. the issued SQL actually binds the tenant filter (regression guard
//      against someone "optimising" the query and dropping the WHERE).
//
// Run via `npm run eval:isolation` (filters to *.isolation.test.ts) or the
// normal `npm test` gate.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// Shared, hoisted so the vi.mock factory can see it.
const h = vi.hoisted(() => {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const seed = [
    { tenant_id: 'tenant-a', content: 'A: operator rejected the comparison-style intro', metadata: { kind: 'rejection' } },
    { tenant_id: 'tenant-b', content: 'B: confidential competitor takedown angle', metadata: { kind: 'rejection' } },
  ]
  return { calls, seed }
})

// Fake pool that emulates the tenant_id=$2 filter the real SQL applies, so the
// test exercises end-to-end behaviour, not just a captured string.
vi.mock('./postgres', () => ({
  pool: {
    query: async (sql: string, params: unknown[]) => {
      h.calls.push({ sql, params })
      const tenantId = params[1] // tenant_id is bound at $2 → params[1]
      const rows = h.seed
        .filter((r) => r.tenant_id === tenantId)
        .map((r) => ({ content: r.content, metadata: r.metadata, similarity: 0.9 }))
      return { rows }
    },
  },
}))

import { config } from '../config'
import { retrieveRelevant } from './vector'

beforeAll(() => {
  // Enable embeddings and make the Voyage call deterministic.
  ;(config as { VOYAGE_API_KEY?: string }).VOYAGE_API_KEY = 'test-key'
  global.fetch = vi.fn(async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] }),
  })) as unknown as typeof fetch
})

beforeEach(() => { h.calls.length = 0 })

describe('semantic recall — cross-tenant isolation', () => {
  it('a tenant-A query never returns tenant-B learnings', async () => {
    const rows = await retrieveRelevant({ tenantId: 'tenant-a', query: 'comparison intro' })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.content.startsWith('A:'))).toBe(true)
    expect(rows.some((r) => r.content.includes('B:'))).toBe(false)
  })

  it('a tenant-B query never returns tenant-A learnings', async () => {
    const rows = await retrieveRelevant({ tenantId: 'tenant-b', query: 'anything' })
    expect(rows.every((r) => r.content.startsWith('B:'))).toBe(true)
  })

  it('binds the tenant filter at $2 (regression guard against dropping WHERE)', async () => {
    await retrieveRelevant({ tenantId: 'tenant-a', query: 'x' })
    const call = h.calls.at(-1)!
    expect(call.sql).toContain('tenant_id=$2')
    expect(call.params[1]).toBe('tenant-a')
  })

  it('tenant-wide recall (no agentType) does not filter by agent_type', async () => {
    await retrieveRelevant({ tenantId: 'tenant-a', query: 'x' })
    expect(h.calls.at(-1)!.sql).not.toContain('agent_type')
  })

  it('specialist-scoped recall adds the agent_type filter and binds it', async () => {
    await retrieveRelevant({ tenantId: 'tenant-a', agentType: 'seo-auditor', query: 'x' })
    const call = h.calls.at(-1)!
    expect(call.sql).toContain('agent_type')
    expect(call.params).toContain('seo-auditor')
  })
})
