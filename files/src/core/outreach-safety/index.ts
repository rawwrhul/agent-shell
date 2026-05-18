// src/core/outreach-safety/index.ts
//
// Spam-safety caps for outbound outreach. Three rules:
//
//   1. Per-tenant daily cap   — at most N sends/tenant/day (default 20)
//   2. Per-prospect uniqueness — never pitch the same target_site twice
//      within the cool-off window (default 60 days)
//   3. Cool-off after no-reply  — once we've pitched and not heard back
//      within 60 days, that prospect is off-limits even if rediscovered
//
// Discovery skills call `canProspect()` BEFORE filing a new outreach_queue
// row to enforce rule 2/3. The approval executor calls `canSendToday()`
// when the operator approves an outreach action to enforce rule 1.

import { pool } from '../../memory/postgres'
import { logger } from '../../logger'

// ── Defaults ────────────────────────────────────────────────────────────

export const DEFAULT_DAILY_SEND_CAP   = 20
export const DEFAULT_COOL_OFF_DAYS    = 60

// ── Per-prospect check (used by discovery skills) ───────────────────────

export interface ProspectGate {
  allowed:   boolean
  reason:    string | null   // null when allowed; explanation when blocked
  lastSentAt: Date | null
}

/**
 * Can we file a new prospect for (tenantId, target_site)?
 *
 * Returns `allowed=false` if:
 *   - We pitched this same target_site in the last `coolOffDays`
 *   - We already have a non-dropped row in outreach_queue for this site
 *     (the existing row is still in progress)
 *
 * The caller (discovery skill) should respect this and skip filing the
 * opportunity. A discovery skill should not delete or modify existing rows.
 */
export async function canProspect(input: {
  tenantId:     string
  targetSite:   string
  coolOffDays?: number
}): Promise<ProspectGate> {
  const coolOffDays = input.coolOffDays ?? DEFAULT_COOL_OFF_DAYS

  const result = await pool.query<{
    status:           string
    sent_at:          Date | null
    last_outreach_at: Date | null
  }>(
    `SELECT status, sent_at, last_outreach_at
     FROM seo.outreach_queue
     WHERE tenant_id = $1
       AND target_site = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.tenantId, input.targetSite],
  )

  if (result.rows.length === 0) {
    return { allowed: true, reason: null, lastSentAt: null }
  }

  const row = result.rows[0]

  // Active prospect already in queue — don't double-file.
  if (row.status === 'queued' || row.status === 'drafted'
      || row.status === 'pending_approval' || row.status === 'sent') {
    return {
      allowed:   false,
      reason:    `existing_prospect_status_${row.status}`,
      lastSentAt: row.sent_at,
    }
  }

  // Dropped or completed — check cool-off.
  const lastTouchAt = row.sent_at ?? row.last_outreach_at
  if (lastTouchAt) {
    const daysSince = Math.floor(
      (Date.now() - lastTouchAt.getTime()) / (24 * 60 * 60 * 1000),
    )
    if (daysSince < coolOffDays) {
      return {
        allowed:    false,
        reason:     `cool_off_active_${daysSince}d_of_${coolOffDays}d`,
        lastSentAt: row.sent_at,
      }
    }
  }

  return { allowed: true, reason: null, lastSentAt: row.sent_at }
}

// ── Daily-send-cap check (used at approval time) ────────────────────────

export interface DailySendGate {
  allowed:    boolean
  reason:     string | null
  sentToday:  number
  cap:        number
}

/**
 * Has this tenant already hit the daily send cap?
 *
 * Counts outreach_queue rows where sent_at is within the last 24 hours.
 * Called from the approval executor when the operator approves an outreach
 * action — if the cap is hit, the approval should be deferred (not
 * rejected) so the operator can either wait or override.
 */
export async function canSendToday(input: {
  tenantId: string
  cap?:     number
}): Promise<DailySendGate> {
  const cap = input.cap ?? DEFAULT_DAILY_SEND_CAP

  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM seo.outreach_queue
     WHERE tenant_id = $1
       AND sent_at > NOW() - INTERVAL '24 hours'`,
    [input.tenantId],
  )
  const sentToday = parseInt(result.rows[0]?.count ?? '0', 10)

  if (sentToday >= cap) {
    return {
      allowed:   false,
      reason:    `daily_cap_reached_${sentToday}_of_${cap}`,
      sentToday,
      cap,
    }
  }
  return { allowed: true, reason: null, sentToday, cap }
}

// ── Mark-sent helper (used at approval time) ────────────────────────────

/**
 * Mark a prospect as 'sent'. Idempotent. Called when the operator approves
 * an outreach action — we trust them to actually send the email from their
 * inbox via the mailto link surfaced in the approval card.
 */
export async function markProspectSent(input: {
  outreachQueueId: string
}): Promise<void> {
  await pool.query(
    `UPDATE seo.outreach_queue
     SET status            = 'sent',
         sent_at           = NOW(),
         last_outreach_at  = NOW()
     WHERE id = $1
       AND status IN ('queued', 'drafted', 'pending_approval')`,
    [input.outreachQueueId],
  )
  logger.info('outreach_prospect_marked_sent', { id: input.outreachQueueId })
}

// ── Mark-dropped helper (used when operator rejects) ────────────────────

export async function markProspectDropped(input: {
  outreachQueueId: string
  reason?:         string | null
}): Promise<void> {
  await pool.query(
    `UPDATE seo.outreach_queue
     SET status           = 'dropped',
         last_outreach_at = NOW(),
         response_summary = COALESCE(response_summary, $2)
     WHERE id = $1`,
    [input.outreachQueueId, input.reason ?? null],
  )
}
