import { describe, it, expect } from 'vitest'
import { isTransientAnthropicError, IdleTimeoutError } from './anthropic-call'

describe('isTransientAnthropicError', () => {
  it('classifies IdleTimeoutError as transient', () => {
    expect(isTransientAnthropicError(new IdleTimeoutError(60_000, 'test'))).toBe(true)
  })

  it('classifies 429 and 5xx as transient', () => {
    expect(isTransientAnthropicError({ status: 429 })).toBe(true)
    expect(isTransientAnthropicError({ status: 503 })).toBe(true)
    expect(isTransientAnthropicError({ status: 529, message: 'Overloaded' })).toBe(true)
  })

  it('classifies connection errors as transient', () => {
    expect(isTransientAnthropicError({ code: 'ECONNRESET' })).toBe(true)
    expect(isTransientAnthropicError({ cause: { code: 'ETIMEDOUT' } })).toBe(true)
    expect(isTransientAnthropicError({ message: 'socket hang up' })).toBe(true)
  })

  it('does NOT classify auth/validation errors as transient', () => {
    expect(isTransientAnthropicError({ status: 401 })).toBe(false)
    expect(isTransientAnthropicError({ status: 400, message: 'invalid_request_error' })).toBe(false)
    expect(isTransientAnthropicError(new Error('something else'))).toBe(false)
    expect(isTransientAnthropicError(null)).toBe(false)
  })
})
