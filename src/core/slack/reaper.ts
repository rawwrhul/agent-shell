// src/core/slack/reaper.ts
//
// Boot-time reaper for stranded runs.
//
// The failure mode: a Cloud Run revision change (every push to main) kills
// the container mid-run. The in-flight BullMQ jobs are lost or fail on the
// new instance, but the slack_runs anchor for the dead run stays on
// 'running' FOREVER — visible to the client as a task that never finishes.
// In-process watchdogs can't catch this because the process that owned the
// watchdog is gone.
//
// The fix: at boot (exactly when a new revision starts), find runs whose
// state is non-terminal and whose row hasn't been touched for longer than
// any healthy run could go silent, and flip them to failed via
// presenter.failRun — which re-renders the anchor so the operator sees an
// honest "failed: orphaned by restart" instead of an eternal spinner.
//
// Staleness uses updated_at, not created_at: every anchor edit bumps
// updated_at, so it tracks liveness. The threshold is generous relative to
// the job watchdogs (orchestrate 5m, subagent 12m, aggregate 5m) — a healthy
// run updates its anchor far more often than every 30 minutes.

import { Pool } from 'pg'
import { presenter } from './index'
import { logger } from '../../logger'

const STALE_AFTER_MINUTES = 30

const TERMINAL_PHASES = ['complete', 'failed'] as const

export async function reapStrandedRuns(pool: Pool): Promise<number> {
  let rows: Array<{ task_id: string; tenant_id: string; phase: string; updated_at: Date }>
  try {
    const res = await pool.query(
      `SELECT task_id, tenant_id, state->>'phase' AS phase, updated_at
         FROM slack_runs
        WHERE COALESCE(state->>'phase', 'starting') NOT IN ('complete', 'failed')
          AND updated_at < now() - ($1 || ' minutes')::interval`,
      [String(STALE_AFTER_MINUTES)],
    )
    rows = res.rows
  } catch (err) {
    logger.error('reaper_query_failed', { err: String(err).slice(0, 300) })
    return 0
  }

  if (!rows.length) {
    logger.info('reaper_no_stranded_runs', {})
    return 0
  }

  let reaped = 0
  for (const r of rows) {
    try {
      await presenter.failRun(
        r.task_id,
        `Run orphaned by a service restart (no activity for ${STALE_AFTER_MINUTES}+ minutes). Re-trigger if still needed.`,
      )
      reaped++
      logger.info('reaper_run_failed_as_stranded', {
        taskId: r.task_id, tenantId: r.tenant_id,
        lastPhase: r.phase, lastUpdated: r.updated_at,
      })
    } catch (err) {
      // failRun edits Slack; a deleted channel or revoked token shouldn't
      // stop the sweep for other tenants.
      logger.warn('reaper_failrun_errored', { taskId: r.task_id, err: String(err).slice(0, 200) })
    }
  }

  logger.info('reaper_complete', { found: rows.length, reaped })
  return reaped
}

export const __testing = { STALE_AFTER_MINUTES, TERMINAL_PHASES }
