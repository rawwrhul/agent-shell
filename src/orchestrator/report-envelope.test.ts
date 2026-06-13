import { describe, it, expect } from 'vitest'
import type { FinalReport } from '../core/slack/blocks/types'
import { validateReportEnvelope } from './report-envelope'

describe('validateReportEnvelope', () => {
  it('accepts a well-formed daily report envelope', () => {
    const report = {
      kind: 'daily',
      tldr: ['did a thing'],
      shippedActions: [],
      newOpportunities: [],
      queuedForToday: [],
      awaitingApproval: [],
    } as unknown as FinalReport
    expect(validateReportEnvelope(report)).toEqual({ ok: true })
  })

  it('accepts ad_hoc_tight (no tldr) with required prose fields', () => {
    const report = {
      kind: 'ad_hoc_tight',
      title: 'Drafted post',
      summary: 'A summary',
      why: 'It matters',
    } as unknown as FinalReport
    expect(validateReportEnvelope(report)).toEqual({ ok: true })
  })

  it('rejects a daily report missing a required array, naming the field', () => {
    const report = {
      kind: 'daily',
      tldr: ['x'],
      shippedActions: [],
      newOpportunities: [],
      queuedForToday: [],
      // awaitingApproval missing
    } as unknown as FinalReport
    const res = validateReportEnvelope(report)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('awaitingApproval')
  })

  it('rejects an empty tldr (renderer assumes at least one line)', () => {
    const report = {
      kind: 'weekly',
      tldr: [],
      topPriorities: [],
      clusterProgress: [],
    } as unknown as FinalReport
    const res = validateReportEnvelope(report)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('tldr')
  })

  it('does not constrain free-form prose inside array elements', () => {
    const report = {
      kind: 'ad_hoc',
      title: 'Check',
      tldr: ['ok'],
      broken: [{ anything: 'goes', here: 123 }],
      working: [],
      leverage: [],
    } as unknown as FinalReport
    expect(validateReportEnvelope(report)).toEqual({ ok: true })
  })
})
