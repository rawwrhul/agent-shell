// src/scheduler/pending-nudge.ts
//
// Pending-too-long approval nudger. Runs daily (or however the scheduler
// fires it). Scans approval_requests for status='pending' rows older than
// the threshold and posts a single consolidated reminder per tenant —
// "you've got N approvals waiting since X."
//
// Each tenant gets at most one nudge per 24h (tracked via the
// last_nudged_at column on approval_requests). After approval is
// resolved (approved/rejected/timed-out), the nudge stops.
//
// Shipped as part of Task 0.5.1 (13 May 2026).

import { Pool } from 'pg'
import { config } from '../config'
import { logger } from '../logger'
import { getTenant } from '../tenants/registry'
import { presenter } from '../core/slack'

const PENDING_THRESHOLD_HOURS = 48     // surface reminders after 2 days
const RENUDGE_COOLDOWN_HOURS  = 24     // don't re-nudge more than once a day

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 })
  return _pool
}

interface PendingGroup {
  tenant_id:        string
  slack_channel_id: string
  pending_count:    number
  oldest_created:   Date
}

/**
 * Run the nudge scan. Posts one Slack message per tenant with pending
 * approvals older than PENDING_THRESHOLD_HOURS that haven't been
 * nudged in the last RENUDGE_COOLDOWN_HOURS.
 *
 * Idempotent: safe to call from any schedule (e.g. once at 11 AM daily).
 * Failures per-tenant are logged but don't block other tenants.
 */
export async function runPendingNudgeScan(): Promise<{ nudged: number; skipped: number }> {
  const groups = await loadGroupsNeedingNudge()
  let nudged = 0
  let skipped = 0

  for (const g of groups) {
    try {
      await nudgeTenant(g)
      nudged++
    } catch (err) {
      logger.warn('pending_nudge_failed_for_tenant', {
        tenantId: g.tenant_id, err: String(err).slice(0, 200),
      })
      skipped++
    }
  }

  logger.info('pending_nudge_scan_complete', { nudged, skipped, totalGroups: groups.length })
  return { nudged, skipped }
}

async function loadGroupsNeedingNudge(): Promise<PendingGroup[]> {
  // Group pending approvals by tenant. Filter to:
  //   - pending status
  //   - created more than threshold ago
  //   - either never nudged OR last nudged before the cooldown window
  // last_nudged_at column is added by the Task 0.5.1 migration.
  const sql = `
    SELECT
      ar.tenant_id,
      COALESCE(ar.slack_channel_id, t.slack_channel_id) AS slack_channel_id,
      COUNT(*) ::int                                    AS pending_count,
      MIN(ar.requested_at)                                AS oldest_created
    FROM approval_requests ar
    JOIN tenants t ON t.tenant_id = ar.tenant_id
    WHERE ar.status = 'pending'
      AND ar.requested_at < NOW() - INTERVAL '${PENDING_THRESHOLD_HOURS} hours'
      AND (
        ar.last_nudged_at IS NULL
        OR ar.last_nudged_at < NOW() - INTERVAL '${RENUDGE_COOLDOWN_HOURS} hours'
      )
      AND t.is_active = true
    GROUP BY ar.tenant_id, COALESCE(ar.slack_channel_id, t.slack_channel_id)
    HAVING COUNT(*) > 0
  `
  const { rows } = await pool().query<PendingGroup>(sql)
  return rows
}

async function nudgeTenant(g: PendingGroup): Promise<void> {
  if (!g.slack_channel_id) {
    logger.info('pending_nudge_skip_no_channel', { tenantId: g.tenant_id })
    return
  }

  const tenant = await getTenant(g.tenant_id)
  if (!tenant) {
    logger.warn('pending_nudge_skip_unknown_tenant', { tenantId: g.tenant_id })
    return
  }

  const daysAgo = Math.floor((Date.now() - new Date(g.oldest_created).getTime()) / 86_400_000)

  await presenter.notifyPendingNudge({
    tenantId:      g.tenant_id,
    channelId:     g.slack_channel_id,
    tenantName:    tenant.clientName,
    pendingCount:  g.pending_count,
    oldestDaysAgo: daysAgo,
  })

  // Mark all currently-pending approvals as nudged so the cooldown applies.
  await pool().query(
    `UPDATE approval_requests
       SET last_nudged_at = NOW()
     WHERE tenant_id = $1 AND status = 'pending'`,
    [g.tenant_id],
  )

  logger.info('pending_nudge_sent', {
    tenantId: g.tenant_id, count: g.pending_count, daysAgo,
  })
}
