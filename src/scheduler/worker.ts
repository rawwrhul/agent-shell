// src/scheduler/worker.ts
//
// BullMQ worker that processes fired scheduled-run jobs. When a tenant's
// daily or weekly cron fires, a job lands here. We then:
//
//   1. Load the tenant config (via getTenant from tenants/registry)
//   2. Synthesise an AgentTask (no Slack mention; triggered by cron)
//   3. Enqueue an orchestrator job via enqueueTask
//   4. Record that the schedule fired
//
// The orchestrator handles the rest exactly like a Slack-mentioned run.
//
// R3.1: stamps `trigger: 'cron-daily' | 'cron-weekly'` on the task so the
// aggregator can pick the right system prompt and FinalReport shape.
//
// Hotfix: uses createRedisConnection helper so Upstash TLS, reconnect
// strategy, and BullMQ-required options are applied consistently with the
// rest of the codebase.

import { Worker, type Job } from 'bullmq';
import { config } from '../config';
import { logger } from '../logger';
import { createRedisConnection } from '../lib/redis';
import {
  SCHEDULE_QUEUE_NAME,
  type ScheduledRunPayload, type RunKind,
} from './types';
import { recordScheduleFired } from './index';
import { getTenant } from '../tenants/registry';
import { enqueueTask } from '../queue/producer';
import type { TaskTrigger } from '../types';

let _worker: Worker<ScheduledRunPayload> | null = null;

export function startScheduleWorker(): Worker<ScheduledRunPayload> {
  if (_worker) return _worker;

  const connection = createRedisConnection({
    host:     config.REDIS_HOST,
    port:     config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    label:    'scheduler-worker',
  });

  _worker = new Worker<ScheduledRunPayload>(
    SCHEDULE_QUEUE_NAME,
    async (job: Job<ScheduledRunPayload>) => {
      await processScheduledJob(job);
    },
    {
      connection,
      concurrency: 4,
    }
  );

  _worker.on('failed', (job, err) => {
    logger.error('schedule_job_failed', {
      jobId: job?.id, payload: job?.data, err: err.message,
    });
  });

  _worker.on('completed', (job) => {
    logger.info('schedule_job_completed', { jobId: job.id, payload: job.data });
  });

  logger.info('schedule_worker_started', { queue: SCHEDULE_QUEUE_NAME });
  return _worker;
}

async function processScheduledJob(job: Job<ScheduledRunPayload>): Promise<void> {
  const { tenantId, runKind } = job.data;

  const tenant = await getTenant(tenantId).catch(() => null);
  if (!tenant) {
    logger.warn('schedule_fired_for_missing_tenant', { tenantId });
    return;
  }
  if (!tenant.isActive) {
    logger.info('schedule_skipped_tenant_inactive', { tenantId });
    return;
  }

  const trigger: TaskTrigger = runKind === 'daily' ? 'cron-daily' : 'cron-weekly';

  const task = await enqueueTask({
    tenantId,
    agentType:      tenant.agentType,
    prompt:         buildPromptForRunKind(runKind, tenant.clientName),
    slackChannelId: tenant.slackChannelId,
    slackUserId:    '_cron_',
    trigger,
  });

  await recordScheduleFired(tenantId, runKind, new Date());

  logger.info('schedule_run_enqueued', {
    tenantId, runKind, trigger, taskId: task.id,
  });
}

function buildPromptForRunKind(kind: RunKind, clientName: string): string {
  if (kind === 'daily') {
    // GENERATION-FIRST daily prompt. The cron's job is to populate tomorrow's
    // work pipeline, not to passively report state. The subagent's system
    // prompt (when task_intent='daily_generation') expands on this with
    // the four pillars (new pages, internal links, additive copy/meta,
    // backlink opportunities) and the strict sequence.
    return `Daily generation run for ${clientName}.

Your job today is to PRODUCE WORK so the operator wakes up to a queue of decisions. Snapshotting metrics is the last step, not the first.

This run is FAILED if it produces zero new propose_action calls AND zero new seo_opportunities rows. Target output: 2-5 propose_action calls + 3-5 seo_opportunities entries across the four pillars (new pages, internal links, additive copy/meta, backlink opportunities).

Sequence (strict):
1. Research — DataForSEO + Framer + competitor analysis to gather raw material
2. Ideate — match findings against the four pillars
3. Draft — for pillars 1-3, create Framer drafts via framer_create_draft_page or framer_update_page_draft BEFORE filing propose_action; the previewUrl from those tools MUST be threaded into propose_action so the Slack approval card includes a clickable preview link
4. File — propose_action for pillars 1-3 (with previewUrl), log_opportunity for pillar 4 (backlinks need human outreach, not a click)
5. Snapshot — snapshot_metrics last, for the baseline
6. Report — write findings to output.md, end with SPECIALIST_COMPLETE

Before filing propose_action, query approval_requests and seo_work_log for the last 7 days to avoid proposing duplicates.`;
  }
  return `Weekly audit for ${clientName}. Produce a strategic state-of-play covering: ` +
    `keyword movement, cluster progress vs targets, competitor activity, ` +
    `risk flags, and the top 3 leverage moves for the coming week.`;
}
