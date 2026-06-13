import { describe, it, expect } from 'vitest'
import { toPromptString } from './context'
import type { MemoryContext } from './types'

const emptyCtx = (): MemoryContext => ({
  tenantId: 't1',
  taskType: 'orchestration',
  recentWins: [],
  recentLosses: [],
  inProgress: [],
  learnings: [],
  constraints: [],
  preferences: [],
  facts: [],
  estimatedTokens: 0,
})

describe('toPromptString semantic recall', () => {
  it('renders a relevant_recall section with kind tag and relevance', () => {
    const ctx = emptyCtx()
    ctx.semanticRecall = [
      { content: 'Operator rejected: comparison-style intro. Reason: too salesy.', similarity: 0.82, kind: 'rejection' },
    ]
    const out = toPromptString(ctx)
    expect(out).toContain('<relevant_recall>')
    expect(out).toContain('[rejection]')
    expect(out).toContain('comparison-style intro')
    expect(out).toContain('relevance 0.82')
  })

  it('omits the section entirely when there is no recall', () => {
    const out = toPromptString(emptyCtx())
    expect(out).not.toContain('relevant_recall')
    // all slices empty → the first-run empty marker
    expect(out).toContain('<empty>')
  })

  it('renders without a kind tag when metadata.kind is absent', () => {
    const ctx = emptyCtx()
    ctx.semanticRecall = [{ content: 'Published a pricing FAQ that lifted impressions.', similarity: 0.55 }]
    const out = toPromptString(ctx)
    expect(out).toContain('<relevant_recall>')
    expect(out).not.toContain('[undefined]')
    expect(out).toContain('relevance 0.55')
  })
})
