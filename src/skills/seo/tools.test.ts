import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (must be declared before imports) ──────────────────────────────────

vi.mock('../../hitl/state-store', () => ({
  createApproval: vi.fn(),
  recordSheetRowNumber: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../hitl/sheets', () => ({
  createApprovalRequest: vi.fn().mockResolvedValue({ rowNumber: null }),
}))

vi.mock('../../tenants/registry', () => ({
  getTenant: vi.fn().mockResolvedValue({
    tenantId:             'test-tenant',
    clientName:           'Test Co',
    agentType:            'seo',
    slackBotToken:        'xoxb-test',
    slackAppToken:        'xapp-test',
    slackSigningSecret:   'secret',
    hitlSheetId:          'sheet-id',
    googleSaEmail:        'sa@test.com',
    googlePrivateKey:     '-----BEGIN RSA PRIVATE KEY-----',
    tokenBudgetPerRun:    100000,
    skills:               ['seo'],
    slackChannelId:       'C_TEST',
    hitlSheetName:        'Approvals',
    billingTag:           'test',
    isActive:             true,
    agentModel:           'claude-sonnet-4-6',
  }),
}))

vi.mock('../../core/slack', () => ({
  presenter: {
    requestApproval: vi.fn().mockResolvedValue(undefined),
  },
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { executeSeoTool, SeoToolContext } from './tools'
import { createApproval } from '../../hitl/state-store'
import { presenter } from '../../core/slack'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const APPROVAL_ID = 'aaaabbbb-0000-0000-0000-000000000000'

function mockApproval(overrides: Record<string, unknown> = {}) {
  return {
    id:             APPROVAL_ID,
    tenantId:       'test-tenant',
    taskId:         'task-1',
    sessionId:      null,
    toolName:       'framer_update_page',
    toolInput:      {},
    riskLevel:      'low',
    riskReason:     'Title too long',
    priority:       'P1',
    proposedAction: 'Trim homepage title to 52 chars',
    detail:         [],
    whyPriority:    'Gets cut off in search results',
    status:         'pending',
    requestedAt:    new Date(),
    resolvedAt:     null,
    resolvedBy:     null,
    slackChannelId: null,
    slackMessageTs: null,
    sheetRowNumber: null,
    ...overrides,
  }
}

const baseInput = {
  toolName:       'framer_update_page',
  toolInput:      { pageId: 'abc', title: 'New Title' },
  proposedAction: 'Trim homepage title to 52 chars',
  whyPriority:    'Gets cut off in Google search results',
  priority:       'P1',
  riskLevel:      'low',
}

const ctxWithChannel: SeoToolContext = {
  tenantId:  'test-tenant',
  runId:     'run-1',
  taskId:    'task-1',
  channelId: 'C_CHANNEL',
}

const ctxWithoutChannel: SeoToolContext = {
  tenantId: 'test-tenant',
  runId:    'run-1',
  taskId:   'task-1',
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('propose_action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createApproval).mockResolvedValue(mockApproval() as never)
  })

  it('calls presenter.requestApproval when channelId is set', async () => {
    await executeSeoTool('propose_action', baseInput, ctxWithChannel)

    expect(vi.mocked(presenter.requestApproval)).toHaveBeenCalledOnce()
    expect(vi.mocked(presenter.requestApproval)).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId:  'test-tenant',
        channelId: 'C_CHANNEL',
        taskId:    'task-1',
        toolName:  'framer_update_page',
        approvalId: APPROVAL_ID,
      })
    )
  })

  it('falls back to tenant.slackChannelId when ctx.channelId is absent (Task 0.5.1 hotfix)', async () => {
    await executeSeoTool('propose_action', baseInput, ctxWithoutChannel)

    // Mock tenant has slackChannelId='C_TEST' — should be used as fallback
    expect(vi.mocked(presenter.requestApproval)).toHaveBeenCalledOnce()
    const call = vi.mocked(presenter.requestApproval).mock.calls[0][0]
    expect(call.channelId).toBe('C_TEST')
  })

  it('does NOT call presenter.requestApproval when neither ctx.channelId nor tenant.slackChannelId is set', async () => {
    const { getTenant } = await import('../../tenants/registry')
    vi.mocked(getTenant).mockResolvedValueOnce({
      tenantId: 'test-tenant', clientName: 'Test Co', slackChannelId: null,
    } as never)
    await executeSeoTool('propose_action', baseInput, ctxWithoutChannel)
    expect(vi.mocked(presenter.requestApproval)).not.toHaveBeenCalled()
  })

  it('puts proposedAction in summary and whyPriority in riskReason', async () => {
    await executeSeoTool('propose_action', baseInput, ctxWithChannel)

    const call = vi.mocked(presenter.requestApproval).mock.calls[0][0]
    expect(call.summary).toBe('Trim homepage title to 52 chars')
    expect(call.riskReason).toBe('Gets cut off in Google search results')
  })

  it('passes tenant clientName as tenantName for friendly card headline', async () => {
    await executeSeoTool('propose_action', baseInput, ctxWithChannel)
    const call = vi.mocked(presenter.requestApproval).mock.calls[0][0]
    expect(call.tenantName).toBe('Test Co')
  })

  it('falls back to "Priority X." in riskReason when whyPriority is missing', async () => {
    await executeSeoTool('propose_action', { ...baseInput, whyPriority: undefined }, ctxWithChannel)
    const call = vi.mocked(presenter.requestApproval).mock.calls[0][0]
    expect(call.riskReason).toBe('Priority P1.')
  })

  it('is best-effort: presenter failure does not propagate', async () => {
    vi.mocked(presenter.requestApproval).mockRejectedValueOnce(new Error('Slack API down'))

    const result = await executeSeoTool('propose_action', baseInput, ctxWithChannel)

    // Should still return success — Slack post is best-effort
    expect(result).toContain('filed')
  })

  it('returns a string mentioning the approval short-id', async () => {
    const result = await executeSeoTool('propose_action', baseInput, ctxWithChannel)
    expect(result).toContain('aaaabbbb')
  })

  // ── Task 0.5: previewUrl plumbing ──────────────────────────────────────

  it('threads previewUrl into createApproval when supplied', async () => {
    await executeSeoTool(
      'propose_action',
      { ...baseInput, previewUrl: 'https://staging.example.com/preview/abc' },
      ctxWithChannel,
    )
    expect(vi.mocked(createApproval)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ previewUrl: 'https://staging.example.com/preview/abc' }),
    )
  })

  it('threads previewUrl into presenter.requestApproval when supplied', async () => {
    await executeSeoTool(
      'propose_action',
      { ...baseInput, previewUrl: 'https://staging.example.com/preview/abc' },
      ctxWithChannel,
    )
    expect(vi.mocked(presenter.requestApproval)).toHaveBeenCalledWith(
      expect.objectContaining({ previewUrl: 'https://staging.example.com/preview/abc' }),
    )
  })

  it('omits previewUrl when not supplied (undefined, not empty string)', async () => {
    await executeSeoTool('propose_action', baseInput, ctxWithChannel)
    const presenterCall = vi.mocked(presenter.requestApproval).mock.calls[0][0]
    expect(presenterCall.previewUrl).toBeUndefined()
    const approvalCall = vi.mocked(createApproval).mock.calls[0][1]
    expect(approvalCall.previewUrl).toBeUndefined()
  })

  // ── Task 0.5.1: cron-fired runs batch approvals in the final report ──

  it('SUPPRESSES the individual Slack card when triggerSource is cron-daily', async () => {
    const cronCtx: SeoToolContext = {
      tenantId:      'test-tenant',
      runId:         'run-1',
      taskId:        'task-1',
      channelId:     'C_CHANNEL',
      triggerSource: 'cron-daily',
    }
    await executeSeoTool('propose_action', baseInput, cronCtx)

    // DB write still happens
    expect(vi.mocked(createApproval)).toHaveBeenCalledOnce()
    // BUT no Slack card — the daily report will surface this approval inline
    expect(vi.mocked(presenter.requestApproval)).not.toHaveBeenCalled()
  })

  it('SUPPRESSES the individual Slack card when triggerSource is cron-weekly', async () => {
    const cronCtx: SeoToolContext = {
      tenantId:      'test-tenant',
      runId:         'run-1',
      taskId:        'task-1',
      channelId:     'C_CHANNEL',
      triggerSource: 'cron-weekly',
    }
    await executeSeoTool('propose_action', baseInput, cronCtx)
    expect(vi.mocked(presenter.requestApproval)).not.toHaveBeenCalled()
  })

  it('STILL POSTS individual Slack card for ad-hoc triggers (slack-mention)', async () => {
    const adHocCtx: SeoToolContext = {
      tenantId:      'test-tenant',
      runId:         'run-1',
      taskId:        'task-1',
      channelId:     'C_CHANNEL',
      triggerSource: 'slack-mention',
    }
    await executeSeoTool('propose_action', baseInput, adHocCtx)
    expect(vi.mocked(presenter.requestApproval)).toHaveBeenCalledOnce()
  })

  it('defaults to posting individual cards when triggerSource is undefined (back-compat)', async () => {
    // ctxWithChannel has no triggerSource — should behave as ad-hoc
    await executeSeoTool('propose_action', baseInput, ctxWithChannel)
    expect(vi.mocked(presenter.requestApproval)).toHaveBeenCalledOnce()
  })
})
