import { describe, it, expect } from 'vitest'
import {
  buildProposalCard,
  buildProposalFallbackText,
  buildResolvedCard,
  formatRelativeTime,
} from './proposal-card'
import type { ApprovalCardData } from './types'

const baseData: ApprovalCardData = {
  approvalId:     'test-approval-id-123',
  toolName:       'framer_update_page',
  proposedAction: 'Trim homepage title from 87 to 52 characters',
  whyPriority:    'The current title is being cut off in search results',
  riskLevel:      'low',
  requestedAt:    new Date('2026-05-13T10:00:00Z'),
  specialistType: 'technical-auditor',
}

describe('buildProposalCard', () => {
  it('returns a non-empty blocks array', () => {
    const blocks = buildProposalCard(baseData)
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('includes a header block with "Needs your call"', () => {
    const blocks = buildProposalCard(baseData)
    const header = blocks.find(b => b.type === 'header')
    expect(header).toBeDefined()
    if (header?.type === 'header') {
      expect(header.text.text).toContain('Needs your call')
    }
  })

  it('includes the proposed action text', () => {
    const blocks = buildProposalCard(baseData)
    const hasAction = blocks.some(b => {
      if (b.type !== 'section') return false
      const text = 'text' in b && b.text ? String(b.text.text) : ''
      return text.includes('Trim homepage title')
    })
    expect(hasAction).toBe(true)
  })

  it('includes the whyPriority text', () => {
    const blocks = buildProposalCard(baseData)
    const hasWhy = blocks.some(b => {
      if (b.type !== 'section') return false
      const text = 'text' in b && b.text ? String(b.text.text) : ''
      return text.includes('cut off in search results')
    })
    expect(hasWhy).toBe(true)
  })

  it('includes approve and reject buttons', () => {
    const blocks = buildProposalCard(baseData)
    const actionsBlock = blocks.find(b => b.type === 'actions')
    expect(actionsBlock).toBeDefined()
    if (actionsBlock?.type === 'actions') {
      const actions = actionsBlock.elements
      const approve = actions.find(a => a.type === 'button' && a.action_id === 'approve_action')
      const reject  = actions.find(a => a.type === 'button' && a.action_id === 'reject_action')
      expect(approve).toBeDefined()
      expect(reject).toBeDefined()
    }
  })

  it('encodes approvalId in button values', () => {
    const blocks = buildProposalCard(baseData)
    const actionsBlock = blocks.find(b => b.type === 'actions')
    if (actionsBlock?.type === 'actions') {
      for (const action of actionsBlock.elements) {
        if (action.type === 'button') {
          expect(action.value).toBe('test-approval-id-123')
        }
      }
    }
  })

  it('shows green emoji for low risk', () => {
    const blocks = buildProposalCard({ ...baseData, riskLevel: 'low' })
    const header = blocks.find(b => b.type === 'header')
    if (header?.type === 'header') {
      expect(header.text.text).toContain('🟢')
    }
  })

  it('shows red emoji for critical risk', () => {
    const blocks = buildProposalCard({ ...baseData, riskLevel: 'critical' })
    const header = blocks.find(b => b.type === 'header')
    if (header?.type === 'header') {
      expect(header.text.text).toContain('🔴')
    }
  })

  it('shows orange emoji for high risk', () => {
    const blocks = buildProposalCard({ ...baseData, riskLevel: 'high' })
    const header = blocks.find(b => b.type === 'header')
    if (header?.type === 'header') {
      expect(header.text.text).toContain('🟠')
    }
  })

  it('shows yellow emoji for medium risk', () => {
    const blocks = buildProposalCard({ ...baseData, riskLevel: 'medium' })
    const header = blocks.find(b => b.type === 'header')
    if (header?.type === 'header') {
      expect(header.text.text).toContain('🟡')
    }
  })

  it('includes toolName in context', () => {
    const blocks = buildProposalCard(baseData)
    const hasContext = blocks.some(b => {
      if (b.type !== 'context') return false
      return b.elements.some(e => e.type === 'mrkdwn' && e.text.includes('framer_update_page'))
    })
    expect(hasContext).toBe(true)
  })

  it('includes specialistType in context', () => {
    const blocks = buildProposalCard(baseData)
    const hasContext = blocks.some(b => {
      if (b.type !== 'context') return false
      return b.elements.some(e => e.type === 'mrkdwn' && e.text.includes('technical-auditor'))
    })
    expect(hasContext).toBe(true)
  })
})

describe('buildProposalFallbackText', () => {
  it('includes the proposed action', () => {
    const text = buildProposalFallbackText(baseData)
    expect(text).toContain('Trim homepage title')
  })

  it('includes "Needs your call"', () => {
    const text = buildProposalFallbackText(baseData)
    expect(text).toContain('Needs your call')
  })

  it('includes a risk emoji', () => {
    const text = buildProposalFallbackText(baseData)
    expect(text).toMatch(/[🟢🟡🟠🔴]/)
  })
})

describe('buildResolvedCard', () => {
  it('shows approved state', () => {
    const blocks = buildResolvedCard(baseData, {
      status: 'approved',
      resolvedBy: 'U123',
      resolvedAt: new Date(),
    })
    const hasApproved = blocks.some(b => {
      if (b.type !== 'section') return false
      const text = 'text' in b && b.text ? String(b.text.text) : ''
      return text.includes('Approved') && text.includes('✅')
    })
    expect(hasApproved).toBe(true)
  })

  it('shows rejected state', () => {
    const blocks = buildResolvedCard(baseData, {
      status: 'rejected',
      resolvedBy: 'U456',
      resolvedAt: new Date(),
    })
    const hasRejected = blocks.some(b => {
      if (b.type !== 'section') return false
      const text = 'text' in b && b.text ? String(b.text.text) : ''
      return text.includes('Rejected') && text.includes('❌')
    })
    expect(hasRejected).toBe(true)
  })

  it('mentions the resolver', () => {
    const blocks = buildResolvedCard(baseData, {
      status: 'approved',
      resolvedBy: 'UABC',
      resolvedAt: new Date(),
    })
    const hasMention = blocks.some(b => {
      if (b.type !== 'context') return false
      return b.elements.some(e => e.type === 'mrkdwn' && e.text.includes('<@UABC>'))
    })
    expect(hasMention).toBe(true)
  })
})

describe('formatRelativeTime', () => {
  it('returns "just now" for < 1 minute', () => {
    expect(formatRelativeTime(new Date(Date.now() - 30_000))).toBe('just now')
  })

  it('returns minutes for < 1 hour', () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000))).toBe('5m ago')
  })

  it('returns hours for < 1 day', () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 3_600_000))).toBe('3h ago')
  })

  it('returns days for >= 1 day', () => {
    expect(formatRelativeTime(new Date(Date.now() - 2 * 86_400_000))).toBe('2d ago')
  })
})
