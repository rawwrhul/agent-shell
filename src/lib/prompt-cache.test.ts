import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { withMovingMessageBreakpoint } from './prompt-cache'

const lastBlockCacheControl = (msgs: Anthropic.MessageParam[]) => {
  const last = msgs[msgs.length - 1]
  if (typeof last.content === 'string') return undefined
  const block = last.content[last.content.length - 1] as { cache_control?: unknown }
  return block.cache_control
}

describe('withMovingMessageBreakpoint', () => {
  it('wraps a trailing string message into a cached text block', () => {
    const out = withMovingMessageBreakpoint([{ role: 'user', content: 'hello' }])
    const last = out[0]
    expect(Array.isArray(last.content)).toBe(true)
    expect(lastBlockCacheControl(out)).toEqual({ type: 'ephemeral' })
  })

  it('adds the breakpoint to the last block only, leaving earlier turns alone', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ]
    const out = withMovingMessageBreakpoint(msgs)
    expect(typeof out[0].content).toBe('string') // earlier turn untouched
    expect(lastBlockCacheControl(out)).toEqual({ type: 'ephemeral' })
  })

  it('is idempotent — does not double-mark an already-cached tail', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] },
    ]
    const out = withMovingMessageBreakpoint(msgs)
    expect(out).toBe(msgs) // same reference back, no rewrap
  })

  it('returns input untouched for empty message lists', () => {
    const empty: Anthropic.MessageParam[] = []
    expect(withMovingMessageBreakpoint(empty)).toBe(empty)
  })

  it('does not mutate the input array or its messages', () => {
    const msgs: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }]
    const snapshot = JSON.stringify(msgs)
    withMovingMessageBreakpoint(msgs)
    expect(JSON.stringify(msgs)).toBe(snapshot)
  })
})
