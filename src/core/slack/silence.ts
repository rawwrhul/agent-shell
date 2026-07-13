// src/core/slack/silence.ts
//
// Tenant-level Slack silence. autonomy_level='full' tenants post NOTHING to
// Slack — no anchors, no receipts, no cards. There is no human approval, so
// there is no human channel: the DB is the complete record (approval_requests
// for pending human work, daily_digests for the day's summary, seo_work_log +
// execution_jobs for every action, Cloud Run logs for failures).
//
// Direct SQL on tenants.autonomy_level with a short cache — deliberately does
// NOT go through getTenant, which would resolve Slack secrets from Secret
// Manager just to decide not to use them.
//
// Fails OPEN (not silent): if the lookup errors, we post. Losing a message a
// human doesn't need is worse than losing the error that says why the lookup
// broke.

import type { Pool } from 'pg'
import { logger } from '../../logger'

const cache = new Map<string, { silent: boolean; exp: number }>()
const TTL = 5 * 60 * 1000

export async function isSilentTenant(pool: Pool, tenantId: string): Promise<boolean> {
  const hit = cache.get(tenantId)
  if (hit && hit.exp > Date.now()) return hit.silent

  try {
    const { rows } = await pool.query<{ autonomy_level: string | null }>(
      `SELECT autonomy_level FROM tenants WHERE tenant_id = $1`,
      [tenantId],
    )
    const silent = rows[0]?.autonomy_level === 'full'
    cache.set(tenantId, { silent, exp: Date.now() + TTL })
    return silent
  } catch (err) {
    logger.warn('silence_lookup_failed', { tenantId, err: String(err).slice(0, 160) })
    return false
  }
}

/** Placeholder anchor ts for silent runs — keeps slack_runs state machinery
 *  intact without a real Slack message behind it. */
export const SILENT_ANCHOR_TS = '_silent_'
