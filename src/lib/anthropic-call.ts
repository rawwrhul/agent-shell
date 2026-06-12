// src/lib/anthropic-call.ts
//
// Single entry point for ALL Anthropic Messages API calls in the shell.
//
// Why streaming + idle timeout instead of messages.create + wall-clock abort:
//   A wall-clock AbortController kills long-but-healthy generations — a
//   16K-token report streams for several minutes and trips a 90s timer even
//   though nothing is wrong. The failure mode we actually want to catch is
//   SILENCE: a connection that stops emitting events. So we use
//   messages.stream() and reset an idle timer on every streamEvent, aborting
//   only if the stream goes quiet for idleTimeoutMs. Long healthy generations
//   never time out; genuinely hung connections die in idleTimeoutMs instead
//   of the SDK's 10-minute default.
//
// Retry policy: transient errors (429 / 5xx / connection resets / idle
// silence) retry with exponential backoff. An abort fired by OUR idle timer
// surfaces from the SDK as APIUserAbortError, which retry layers would
// normally treat as a deliberate cancel — so we re-throw it as
// IdleTimeoutError, which IS classified transient.
//
// This wrapper is also the designated insertion point for BudgetTracker
// (deferred rollout): usage recording and cap enforcement land here so call
// sites never migrate twice.

import Anthropic from '@anthropic-ai/sdk'
import { logger } from '../logger'

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ECONNREFUSED',
])

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])

export class IdleTimeoutError extends Error {
  constructor(public readonly idleMs: number, public readonly label: string) {
    super(`anthropic stream idle for ${idleMs}ms (${label})`)
    this.name = 'IdleTimeoutError'
  }
}

interface AnthropicErrorLike {
  code?: string
  status?: number
  cause?: { code?: string }
  message?: string
}

export function isTransientAnthropicError(err: unknown): boolean {
  if (err instanceof IdleTimeoutError) return true
  if (!err || typeof err !== 'object') return false
  const e = err as AnthropicErrorLike
  const code = e.code ?? e.cause?.code
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true
  if (typeof e.status === 'number' && TRANSIENT_HTTP_STATUSES.has(e.status)) return true
  const msg = (e.message ?? '').toLowerCase()
  if (msg.includes('econnreset') || msg.includes('timeout') || msg.includes('socket hang up') || msg.includes('overloaded')) {
    return true
  }
  return false
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export interface CallAnthropicOpts {
  /** Abort if the stream emits nothing for this long. Default 60s. */
  idleTimeoutMs?: number
  /** Total attempts including the first. Default 3. */
  maxRetries?: number
  /** Base for exponential backoff between retries. Default 1000ms. */
  retryBaseDelayMs?: number
  /** Tag for log lines so failures are attributable per call site. */
  label?: string
}

/**
 * Make one Messages API call via streaming with idle-silence detection and
 * transient-error retry. Returns the assembled final Message — drop-in
 * replacement for `await client.messages.create(params)`.
 */
export async function callAnthropic(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: CallAnthropicOpts = {},
): Promise<Anthropic.Message> {
  const idleMs     = opts.idleTimeoutMs    ?? 60_000
  const maxRetries = opts.maxRetries       ?? 3
  const baseDelay  = opts.retryBaseDelayMs ?? 1_000
  const label      = opts.label            ?? 'anthropic'

  let attempt = 0
  for (;;) {
    attempt++
    try {
      return await streamOnce(client, params, idleMs, label)
    } catch (err) {
      const transient = isTransientAnthropicError(err)
      if (attempt >= maxRetries || !transient) {
        logger.error('anthropic_call_failed', {
          label, attempt, max: maxRetries, transient,
          err: String(err).slice(0, 400),
        })
        throw err
      }
      const delay = baseDelay * Math.pow(2, attempt - 1)
      logger.warn('anthropic_call_retrying', {
        label, attempt, nextAttempt: attempt + 1, delayMs: delay,
        err: String(err).slice(0, 200),
      })
      await sleep(delay)
    }
  }
}

async function streamOnce(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  idleMs: number,
  label:  string,
): Promise<Anthropic.Message> {
  // messages.stream() sets stream:true itself; strip any explicit flag.
  const { stream: _stream, ...body } = params as Anthropic.MessageCreateParamsNonStreaming & { stream?: boolean }

  const stream = client.messages.stream(body as Anthropic.MessageCreateParamsNonStreaming)

  let idleTimer: NodeJS.Timeout | undefined
  let idleFired = false
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleFired = true
      stream.controller.abort()
    }, idleMs)
  }
  stream.on('streamEvent', resetIdle)
  resetIdle()

  try {
    return await stream.finalMessage()
  } catch (err) {
    if (idleFired) throw new IdleTimeoutError(idleMs, label)
    throw err
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}
