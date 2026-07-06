// src/integrations/googleads/quota.ts
//
// Daily operation ceiling guard. Basic/Explorer developer-token tiers cap
// operations per day; blowing through the cap mid-run blocks EVERY tenant
// under the MCC because the token is shared. The guard is per-customer so
// one noisy account cannot starve the roster (per-account capping is
// cleaner than pooled capping across an agency roster).
//
// In-memory is fine for v1: Cloud Run runs a single always-warm instance,
// and a restart resetting counters only risks undercounting on the day of
// the deploy. Move to Redis if minScale ever goes above 1.

import { logger } from '../../logger'

export const DEFAULT_DAILY_OPERATION_CEILING = 2_880

export interface QuotaGuard {
  /** Throws QuotaExceededError when the customer is over its daily ceiling. */
  consume(customerId: string, operations?: number): void
  used(customerId: string): number
}

export class QuotaExceededError extends Error {
  constructor(public readonly customerId: string, public readonly ceiling: number) {
    super(`Google Ads daily operation ceiling (${ceiling}) reached for customer ${customerId}`)
    this.name = 'QuotaExceededError'
  }
}

export class InMemoryQuotaGuard implements QuotaGuard {
  private counts = new Map<string, number>()
  private day = todayUtc()

  constructor(private readonly ceilingPerCustomer = DEFAULT_DAILY_OPERATION_CEILING) {}

  consume(customerId: string, operations = 1): void {
    this.rolloverIfNewDay()
    const used = (this.counts.get(customerId) ?? 0) + operations
    if (used > this.ceilingPerCustomer) {
      throw new QuotaExceededError(customerId, this.ceilingPerCustomer)
    }
    this.counts.set(customerId, used)
    if (used === Math.floor(this.ceilingPerCustomer * 0.8)) {
      logger.warn('google_ads_quota_80pct', { customerId, used, ceiling: this.ceilingPerCustomer })
    }
  }

  used(customerId: string): number {
    this.rolloverIfNewDay()
    return this.counts.get(customerId) ?? 0
  }

  private rolloverIfNewDay(): void {
    const now = todayUtc()
    if (now !== this.day) {
      this.day = now
      this.counts.clear()
    }
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}
