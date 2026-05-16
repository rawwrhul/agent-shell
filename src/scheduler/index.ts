// src/scheduler/index.ts

import { Pool } from 'pg';
import { Queue, type RepeatOptions } from 'bullmq';
import { type Redis } from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';
import { createRedisConnection } from '../lib/redis';
import {
  SCHEDULE_QUEUE_NAME, repeatableJobIdFor,
  type TenantSchedule, type ScheduledRunPayload, type RunKind,
} from './types';

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL });
  return _pool;
}

let _connection: Redis | null = null;
function connection(): Redis {
  if (!_connection) {
    _connection = createRedisConnection({
      host:     config.REDIS_HOST,
      port:     config.REDIS_PORT,
      password: config.REDIS_PASSWORD,
      label:    'scheduler-control',
    });
  }
  return _connection;
}

let _queue: Queue<ScheduledRunPayload> | null = null;
function queue(): Queue<ScheduledRunPayload> {
  if (!_queue) {
    _queue = new Queue<ScheduledRunPayload>(SCHEDULE_QUEUE_NAME, { connection: connection() });
  }
  return _queue;
}

export async function bootstrapSchedules(): Promise<void> {
  const schedules = await listEnabledSchedules();

  // Build the set of jobIds we WANT in Redis (excluding deprecated
  // weekly). Anything else in Redis is orphaned and should be removed.
  const desired = new Set(
    schedules
      .filter(s => s.runKind !== 'weekly')
      .map(s => repeatableJobIdFor(s))
  );

  // Reconcile: remove repeatables in Redis that aren't in the desired
  // set. Catches stale weekly jobs from before the 2026-05-16 deprecation,
  // and schedules whose cron expression has changed (old + new would
  // otherwise coexist and double-fire).
  try {
    const existing = await queue().getRepeatableJobs();
    for (const j of existing) {
      if (!j.id) continue;
      if (j.id === 'global:pending-nudge-scan') continue;
      if (!desired.has(j.id)) {
        await queue().removeRepeatableByKey(j.key);
        logger.info('schedule_orphan_removed', { jobId: j.id, pattern: j.pattern });
      }
    }
  } catch (err) {
    logger.warn('schedule_reconcile_failed', { err: String(err) });
  }

  for (const s of schedules) {
    // Weekly runs deprecated 2026-05-16. Filter here as a safety net so
    // weekly schedules can't fire even if a DB row is still enabled.
    // To re-enable: remove this block AND uncomment the weekly call in
    // applyDefaultSchedulesFor (src/scheduler/config.ts).
    if (s.runKind === 'weekly') {
      logger.info('schedule_skipped_weekly_deprecated', {
        tenantId: s.tenantId, runKind: s.runKind,
      });
      continue;
    }
    await registerRepeatable(s).catch(err => {
      logger.error('schedule_register_failed', {
        tenantId: s.tenantId, runKind: s.runKind, err: String(err),
      });
    });
  }

  // Task 0.5.1: register the global pending-nudge scan as a separate
  // repeatable job. Fires once daily at 11 AM (operator's local TZ —
  // approximate; we use Sydney since that's the primary tenant). The
  // scan checks every tenant in one pass and posts at most one nudge
  // per tenant per cooldown window.
  await registerPendingNudgeScan().catch(err => {
    logger.error('pending_nudge_register_failed', { err: String(err) });
  });

  logger.info('scheduler_bootstrapped', { count: schedules.length });
}

async function registerPendingNudgeScan(): Promise<void> {
  const jobId = 'global:pending-nudge-scan';
  const repeatOpts: RepeatOptions = {
    pattern: '0 11 * * *',          // 11:00 every day
    tz:      'Australia/Sydney',
  };

  // Remove any existing repeatable for this jobId regardless of its
  // old cron pattern. The previous removeRepeatableByPattern matched on
  // jobId+pattern+tz, which silently left stale repeatables behind when
  // the cron expression changed — causing double-firing. The reconcile
  // loop in bootstrapSchedules would also catch this, but fixing it here
  // makes registerRepeatable correct in isolation.
  try {
    const repeatableJobs = await queue().getRepeatableJobs();
    for (const j of repeatableJobs) {
      if (j.id === jobId) {
        await queue().removeRepeatableByKey(j.key);
      }
    }
  } catch (err) {
    logger.warn('register_remove_existing_failed', {
      jobId, err: String(err),
    });
  }

  await queue().add(
    'pending-nudge-scan',
    // Reuse ScheduledRunPayload shape with sentinel values to satisfy
    // the worker's type signature; the worker dispatches on job.name
    // rather than payload contents for this job type.
    {
      tenantId:   '_global_',
      runKind:    'daily' as RunKind,
      triggerAt:  '',
      scheduleId: jobId,
    },
    { repeat: repeatOpts, jobId }
  );
  logger.info('pending_nudge_registered', { cron: repeatOpts.pattern, tz: repeatOpts.tz });
}

export async function upsertSchedule(input: {
  tenantId: string;
  runKind:  RunKind;
  cronExpr: string;
  timezone: string;
  enabled?: boolean;
}): Promise<TenantSchedule> {
  const enabled = input.enabled ?? true;
  const { rows } = await pool().query<TenantSchedule>(
    `INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, run_kind) DO UPDATE SET
       cron_expr  = EXCLUDED.cron_expr,
       timezone   = EXCLUDED.timezone,
       enabled    = EXCLUDED.enabled,
       updated_at = now()
     RETURNING
       tenant_id     AS "tenantId",
       run_kind      AS "runKind",
       cron_expr     AS "cronExpr",
       timezone,
       enabled,
       last_fired_at AS "lastFiredAt",
       created_at    AS "createdAt",
       updated_at    AS "updatedAt"`,
    [input.tenantId, input.runKind, input.cronExpr, input.timezone, enabled]
  );
  const schedule = rows[0];

  if (enabled) {
    await registerRepeatable(schedule);
  } else {
    await removeRepeatable(schedule);
  }
  return schedule;
}

export async function disableSchedule(tenantId: string, runKind: RunKind): Promise<void> {
  await pool().query(
    `UPDATE tenant_schedules SET enabled = false, updated_at = now()
     WHERE tenant_id = $1 AND run_kind = $2`,
    [tenantId, runKind]
  );
  await removeRepeatable({ tenantId, runKind } as TenantSchedule);
}

export async function recordScheduleFired(
  tenantId: string, runKind: RunKind, firedAt: Date
): Promise<void> {
  await pool().query(
    `UPDATE tenant_schedules
     SET last_fired_at = $3, updated_at = now()
     WHERE tenant_id = $1 AND run_kind = $2`,
    [tenantId, runKind, firedAt]
  );
}

// ── Internals ─────────────────────────────────────────────────────────

async function listEnabledSchedules(): Promise<TenantSchedule[]> {
  const { rows } = await pool().query<TenantSchedule>(
    `SELECT
       tenant_id     AS "tenantId",
       run_kind      AS "runKind",
       cron_expr     AS "cronExpr",
       timezone,
       enabled,
       last_fired_at AS "lastFiredAt",
       created_at    AS "createdAt",
       updated_at    AS "updatedAt"
     FROM tenant_schedules
     WHERE enabled = true`
  );
  return rows;
}

async function registerRepeatable(schedule: TenantSchedule): Promise<void> {
  const jobId = repeatableJobIdFor(schedule);
  const repeatOpts: RepeatOptions = {
    pattern: schedule.cronExpr,
    tz:      schedule.timezone,
  };

  // Remove any existing repeatable for this jobId regardless of its
  // old cron pattern. The previous removeRepeatableByPattern matched on
  // jobId+pattern+tz, which silently left stale repeatables behind when
  // the cron expression changed — causing double-firing. The reconcile
  // loop in bootstrapSchedules would also catch this, but fixing it here
  // makes registerRepeatable correct in isolation.
  try {
    const repeatableJobs = await queue().getRepeatableJobs();
    for (const j of repeatableJobs) {
      if (j.id === jobId) {
        await queue().removeRepeatableByKey(j.key);
      }
    }
  } catch (err) {
    logger.warn('register_remove_existing_failed', {
      jobId, err: String(err),
    });
  }

  await queue().add(
    'scheduled-run',
    {
      tenantId:   schedule.tenantId,
      runKind:    schedule.runKind,
      triggerAt:  '',
      scheduleId: jobId,
    },
    { repeat: repeatOpts, jobId }
  );
  logger.info('schedule_registered', {
    tenantId: schedule.tenantId, runKind: schedule.runKind, cron: schedule.cronExpr, tz: schedule.timezone,
  });
}

async function removeRepeatable(schedule: Pick<TenantSchedule, 'tenantId' | 'runKind'>): Promise<void> {
  const jobId = repeatableJobIdFor(schedule as TenantSchedule);
  try {
    const repeatableJobs = await queue().getRepeatableJobs();
    for (const j of repeatableJobs) {
      if (j.id === jobId) {
        await queue().removeRepeatableByKey(j.key);
      }
    }
    logger.info('schedule_removed', { tenantId: schedule.tenantId, runKind: schedule.runKind });
  } catch (err) {
    logger.warn('schedule_remove_failed', { tenantId: schedule.tenantId, err: String(err) });
  }
}

async function removeRepeatableByPattern(jobId: string, _opts: RepeatOptions): Promise<void> {
  try {
    const repeatableJobs = await queue().getRepeatableJobs();
    for (const j of repeatableJobs) {
      if (j.id === jobId) {
        await queue().removeRepeatableByKey(j.key);
      }
    }
  } catch {
    // best-effort cleanup; absence is fine
  }
}
