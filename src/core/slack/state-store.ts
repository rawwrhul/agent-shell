// src/core/slack/state-store.ts
//
// Postgres operations for slack_runs. The non-trivial piece is mutateRunState,
// which uses SELECT ... FOR UPDATE so concurrent specialist completions can't
// trample each other's writes.
//
// The mutator function is intentionally synchronous and pure — under
// contention we may briefly hold the row lock, and async work inside the lock
// would extend that window. Render-and-post-to-Slack happens *after* the
// transaction commits, in the presenter.

import type { Pool, PoolClient } from 'pg'
import type { RunState } from './types'
import { RunNotFoundError } from './types'

export interface CreateRunInput {
  taskId:    string
  tenantId:  string
  channelId: string
  anchorTs:  string
  state:     RunState
}

/**
 * Insert a new slack_runs row. Called once per task at the start of the run.
 * If a row already exists for the taskId (e.g. retry after crash), we update
 * the anchor and state — the most recent attempt wins.
 */
export async function createRun(pool: Pool, input: CreateRunInput): Promise<void> {
  await pool.query(
    `INSERT INTO slack_runs (task_id, tenant_id, channel_id, anchor_ts, state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (task_id) DO UPDATE
       SET anchor_ts  = EXCLUDED.anchor_ts,
           state      = EXCLUDED.state,
           updated_at = NOW()`,
    [input.taskId, input.tenantId, input.channelId, input.anchorTs, input.state],
  )
}

export interface RunRow {
  taskId:    string
  tenantId:  string
  channelId: string
  anchorTs:  string
  state:     RunState
}

export async function getRun(pool: Pool, taskId: string): Promise<RunRow | null> {
  const res = await pool.query(
    `SELECT task_id, tenant_id, channel_id, anchor_ts, state
       FROM slack_runs
      WHERE task_id = $1`,
    [taskId],
  )
  if (!res.rows.length) return null
  const r = res.rows[0]
  return {
    taskId:    r.task_id,
    tenantId:  r.tenant_id,
    channelId: r.channel_id,
    anchorTs:  r.anchor_ts,
    state:     r.state as RunState,
  }
}

/**
 * Mutate a run's state under SELECT ... FOR UPDATE. The mutator MUST be a pure
 * function — it can be called more than once if the transaction needs to retry
 * (today pg won't auto-retry, but keeping it pure is cheap insurance and
 * simplifies reasoning about concurrent updates).
 *
 * Returns the new state along with the row's anchor_ts and channel_id, so the
 * caller has everything needed to render and edit the Slack message without a
 * second query.
 *
 * Throws RunNotFoundError if no row exists for taskId — indicates a missing
 * startRun, which is a programming error rather than a transient failure.
 */
export async function mutateRunState(
  pool:    Pool,
  taskId:  string,
  mutator: (state: RunState) => RunState,
): Promise<RunRow> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const sel = await client.query(
      `SELECT tenant_id, channel_id, anchor_ts, state
         FROM slack_runs
        WHERE task_id = $1
        FOR UPDATE`,
      [taskId],
    )

    if (!sel.rows.length) {
      await client.query('ROLLBACK')
      throw new RunNotFoundError(taskId)
    }

    const row = sel.rows[0]
    const current: RunState = row.state
    const next = mutator(current)
    // Always bump revision so callers can detect staleness in their rendered view.
    next.revision = (current.revision ?? 0) + 1

    await client.query(
      `UPDATE slack_runs
          SET state      = $2,
              updated_at = NOW()
        WHERE task_id    = $1`,
      [taskId, next],
    )
    await client.query('COMMIT')

    return {
      taskId,
      tenantId:  row.tenant_id,
      channelId: row.channel_id,
      anchorTs:  row.anchor_ts,
      state:     next,
    }
  } catch (err) {
    await safeRollback(client)
    throw err
  } finally {
    client.release()
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK') } catch { /* swallow */ }
}

/**
 * Phase 9b: reverse lookup of a run by (channel, anchor_ts). Used by the
 * thread-message handler — given a Slack message's channel + thread_ts,
 * find the run anchored there so we can route feedback.
 *
 * Returns null if no run is anchored at that ts (i.e. the thread isn't ours).
 */
export async function findRunByAnchorTs(
  pool:      Pool,
  channelId: string,
  anchorTs:  string,
): Promise<RunRow | null> {
  const res = await pool.query(
    `SELECT task_id, tenant_id, channel_id, anchor_ts, state
       FROM slack_runs
      WHERE channel_id = $1 AND anchor_ts = $2
      LIMIT 1`,
    [channelId, anchorTs],
  )
  if (!res.rows.length) return null
  const r = res.rows[0]
  return {
    taskId:    r.task_id,
    tenantId:  r.tenant_id,
    channelId: r.channel_id,
    anchorTs:  r.anchor_ts,
    state:     r.state as RunState,
  }
}
