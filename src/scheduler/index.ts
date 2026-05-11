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
  for (const s of schedules) {
    await registerRepeatable(s).catch(err => {
      logger.error('schedule_register_failed', {
        tenantId: s.tenantId, runKind: s.runKind, err: String(err),
      });
    });
  }
  logger.info('scheduler_bootstrapped', { count: schedules.length });
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

  await removeRepeatableByPattern(jobId, repeatOpts);

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
