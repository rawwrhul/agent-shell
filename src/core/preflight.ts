// src/core/preflight.ts
//
// Boot-time preflight checks. Run before tenant bots start so credential
// problems are LOUD at deploy time instead of silently degrading for days
// (the Langfuse-401 failure mode: traces dropped, billing attribution gone,
// nobody notices until invoicing).
//
// Policy: preflight NEVER blocks boot. A transient Langfuse outage must not
// take down the whole shell. Every failure logs at error level with enough
// context to fix without spelunking — these lines are the first thing to
// grep after any deploy:
//   preflight_langfuse_auth_failed / preflight_langfuse_unreachable
//   preflight_voyage_key_missing
//   preflight_db_failed

import { Pool } from 'pg'
import { config } from '../config'
import { logger } from '../logger'

export interface PreflightResult {
  langfuseOk: boolean
  voyageOk:   boolean
  dbOk:       boolean
}

export async function runPreflightChecks(): Promise<PreflightResult> {
  const [langfuseOk, dbOk] = await Promise.all([
    checkLangfuseAuth(),
    checkDatabase(),
  ])
  const voyageOk = checkVoyageKeyPresent()

  logger.info('preflight_complete', { langfuseOk, voyageOk, dbOk })
  return { langfuseOk, voyageOk, dbOk }
}

/**
 * Authenticated round-trip to Langfuse. /api/public/projects requires Basic
 * auth (publicKey:secretKey) — a 401 here means the Secret Manager values
 * don't match the Langfuse dashboard, which is exactly the mismatch that
 * silently dropped traces before.
 */
async function checkLangfuseAuth(): Promise<boolean> {
  const host = config.LANGFUSE_HOST
  const auth = Buffer.from(`${config.LANGFUSE_PUBLIC_KEY}:${config.LANGFUSE_SECRET_KEY}`).toString('base64')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/public/projects`, {
      headers: { Authorization: `Basic ${auth}` },
      signal:  controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      logger.error('preflight_langfuse_auth_failed', {
        status: res.status,
        publicKeyPrefix: config.LANGFUSE_PUBLIC_KEY.slice(0, 11),
        hint: 'Secret Manager langfuse-public-key/langfuse-secret-key do not match the Langfuse dashboard. Traces are being DROPPED until fixed. Rotate in dashboard, then: gcloud secrets versions add.',
      })
      return false
    }
    if (!res.ok) {
      logger.error('preflight_langfuse_unreachable', { status: res.status })
      return false
    }
    logger.info('preflight_langfuse_ok', { host })
    return true
  } catch (err) {
    logger.error('preflight_langfuse_unreachable', { err: String(err).slice(0, 300) })
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Presence-only check; vector.ts handles runtime failures gracefully. */
function checkVoyageKeyPresent(): boolean {
  if (!config.VOYAGE_API_KEY) {
    logger.error('preflight_voyage_key_missing', {
      hint: 'Semantic memory disabled this boot. Set VOYAGE_API_KEY (Secret Manager: voyage-api-key) to enable.',
    })
    return false
  }
  logger.info('preflight_voyage_ok', {})
  return true
}

async function checkDatabase(): Promise<boolean> {
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 })
  try {
    await pool.query('SELECT 1')
    logger.info('preflight_db_ok', {})
    return true
  } catch (err) {
    logger.error('preflight_db_failed', { err: String(err).slice(0, 300) })
    return false
  } finally {
    await pool.end().catch(() => {})
  }
}
