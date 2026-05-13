import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB pool before importing the module under test
vi.mock('../../memory/postgres', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}))

// Mock Slack posting so tests don't need a running bot
vi.mock('../../core/slack/index', () => ({
  postBlocksToSlack: vi.fn().mockResolvedValue('mock-ts-1234'),
}))

// Mock tenant registry (used by propose_action)
vi.mock('../../tenants/registry', () => ({
  getTenant: vi.fn(),
}))

import { pool } from '../../memory/postgres'
import { executeSeoTool, isSeoToolName, SEO_TOOLS } from './tools'

const ctx = {
  tenantId:  'test-tenant',
  taskId:    'task-123',
  runId:     'run-123',
  channelId: 'C1234567',
}

describe('SEO_TOOLS', () => {
  it('exports a non-empty tools array', () => {
    expect(SEO_TOOLS.length).toBeGreaterThan(0)
  })

  it('includes propose_action', () => {
    const names = SEO_TOOLS.map(t => t.name)
    expect(names).toContain('propose_action')
  })

  it('includes all write-side tool names', () => {
    const names = SEO_TOOLS.map(t => t.name)
    expect(names).toContain('log_seo_action')
    expect(names).toContain('log_opportunity')
    expect(names).toContain('snapshot_metrics')
    expect(names).toContain('upsert_cluster')
  })
})

describe('isSeoToolName', () => {
  it('returns true for known SEO tools', () => {
    expect(isSeoToolName('propose_action')).toBe(true)
    expect(isSeoToolName('log_seo_action')).toBe(true)
    expect(isSeoToolName('query_opportunities')).toBe(true)
  })

  it('returns false for unknown tools', () => {
    expect(isSeoToolName('read_file')).toBe(false)
    expect(isSeoToolName('unknown_tool')).toBe(false)
    expect(isSeoToolName('')).toBe(false)
  })
})

describe('executeSeoTool — propose_action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const mockPool = pool as unknown as { query: ReturnType<typeof vi.fn> }
    mockPool.query.mockResolvedValue({ rows: [] })
  })

  it('returns an error when required fields are missing', async () => {
    const result = await executeSeoTool('propose_action', {}, ctx)
    expect(result).toContain('required')
  })

  it('writes to approval_requests with correct columns', async () => {
    const mockPool = pool as unknown as { query: ReturnType<typeof vi.fn> }
    await executeSeoTool('propose_action', {
      toolName:       'framer_update_page',
      toolInput:      { pageId: 'abc', title: 'New Title' },
      proposedAction: 'Update the homepage title',
      whyPriority:    'It is too long and gets cut off',
      riskLevel:      'low',
    }, ctx)

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO approval_requests'),
      expect.arrayContaining([
        expect.any(String),       // id (UUID)
        'test-tenant',            // tenant_id
        'task-123',               // task_id
        'run-123',                // session_id / run_id
        'framer_update_page',     // tool_name
      ]),
    )
  })

  it('stores proposedAction inside tool_input JSONB', async () => {
    const mockPool = pool as unknown as { query: ReturnType<typeof vi.fn> }
    await executeSeoTool('propose_action', {
      toolName:       'framer_update_page',
      toolInput:      {},
      proposedAction: 'Trim title to 52 chars',
      whyPriority:    'Truncating in Google',
      riskLevel:      'low',
    }, ctx)

    const insertCall = mockPool.query.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO approval_requests')
    )
    expect(insertCall).toBeDefined()
    const toolInputArg = JSON.parse(String(insertCall![1][5]))
    expect(toolInputArg.proposedAction).toBe('Trim title to 52 chars')
  })

  it('returns a string mentioning the approval ID', async () => {
    const result = await executeSeoTool('propose_action', {
      toolName:       'framer_update_page',
      toolInput:      {},
      proposedAction: 'Fix the title',
      whyPriority:    'It is broken',
      riskLevel:      'medium',
    }, ctx)

    expect(result).toContain('Approval request created')
    expect(result).toContain('Fix the title')
  })

  it('defaults unknown riskLevel to medium', async () => {
    const mockPool = pool as unknown as { query: ReturnType<typeof vi.fn> }
    await executeSeoTool('propose_action', {
      toolName:       'framer_update_page',
      toolInput:      {},
      proposedAction: 'Fix the title',
      whyPriority:    'Broken',
      riskLevel:      'extreme-danger', // invalid
    }, ctx)

    const insertCall = mockPool.query.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO approval_requests')
    )
    expect(insertCall).toBeDefined()
    // risk_level is at index 6 in the values array ($7 parameter = 0-indexed [6])
    expect(insertCall![1][6]).toBe('medium')
  })
})

describe('executeSeoTool — log_seo_action', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('inserts into seo_work_log', async () => {
    const mockPool = pool as unknown as { query: ReturnType<typeof vi.fn> }
    mockPool.query.mockResolvedValue({ rows: [] })

    const result = await executeSeoTool('log_seo_action', {
      actionType: 'title_update',
      summary:    'Updated homepage title',
      status:     'success',
    }, ctx)

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO seo_work_log'),
      expect.arrayContaining(['test-tenant', 'run-123', 'title_update', 'success']),
    )
    expect(result).toContain('Action logged')
  })
})

describe('executeSeoTool — unknown tool', () => {
  it('returns an error message', async () => {
    const result = await executeSeoTool('totally_unknown_tool', {}, ctx)
    expect(result).toContain('Unknown SEO tool')
  })
})
