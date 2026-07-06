// src/integrations/googleads/retry.ts
//
// Backoff wrapper for Google Ads API calls. The client library ships no
// retry of its own, so every call routes through withBackoff.
//
// Retry policy: retry ONLY quota and transient errors. Everything else
// (auth, validation, policy, bad GAQL) fails fast - retrying those wastes
// daily operation quota and delays the real error reaching the operator.

import { errors } from 'google-ads-api'
import { logger } from '../../logger'

export interface BackoffOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?:  number
  label?:       string
}

interface ErrorCodeShape {
  quota_error?:    unknown
  internal_error?: unknown
}

/**
 * True only for errors where a retry is plausibly useful:
 *   - GoogleAdsFailure with a quota_error code (rate limits, daily ceilings)
 *   - GoogleAdsFailure with internal_error TRANSIENT_ERROR / DEADLINE_EXCEEDED
 *   - Raw network-level failures (ECONNRESET, ETIMEDOUT, socket hang up, 503)
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof errors.GoogleAdsFailure) {
    const list = (err.errors ?? []) as Array<{ error_code?: ErrorCodeShape }>
    return list.some((e) => {
      const code = e.error_code
      if (!code) return false
      if (code.quota_error != null) return true
      const internal = code.internal_error
      return internal === 'TRANSIENT_ERROR' || internal === 'DEADLINE_EXCEEDED' || internal === 4 || internal === 5
    })
  }
  const msg = String(err).toLowerCase()
  return (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('unavailable') ||
    msg.includes('503') ||
    msg.includes('deadline')
  )
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4
  const baseDelay   = opts.baseDelayMs ?? 1_000
  const maxDelay    = opts.maxDelayMs  ?? 30_000
  const label       = opts.label       ?? 'google_ads_call'

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === maxAttempts || !isRetryable(err)) throw err
      const jitter = Math.random() * 0.3 + 0.85
      const delay  = Math.min(baseDelay * 2 ** (attempt - 1) * jitter, maxDelay)
      logger.warn('google_ads_retry', {
        label, attempt, maxAttempts, delayMs: Math.round(delay),
        err: String(err).slice(0, 200),
      })
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
