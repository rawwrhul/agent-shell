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
import { getTenant } from '../tenants/registry'
import { runFullAuditCycle } from '../skills/seo-technical-auditor';
import { runBacklinkProspectCycle } from '../skills/seo-backlink-prospector';
import { runBrandMentionScanCycle } from '../skills/seo-brand-mention-monitor';
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
      // Task 0.5.1: scheduler queue now multiplexes two job types.
      //   - 'scheduled-run'      → per-tenant cron task (daily / weekly / end-of-week)
      //   - 'pending-nudge-scan' → global daily scan for stale approvals
      if (job.name === 'pending-nudge-scan') {
        const { runPendingNudgeScan } = await import('./pending-nudge');
        const result = await runPendingNudgeScan();
        logger.info('pending_nudge_scan_done', result);
        return;
      }
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

  // seo_audit runs its own cycle (crawl + audit + memory) directly — does
  // NOT go through the orchestrator/aggregator. The next daily run consumes
  // the findings + opportunities the audit produced.
  if (runKind === 'seo_audit') {
    logger.info('seo_audit_cycle_starting', { tenantId });
    try {
      await runFullAuditCycle(tenantId);
      logger.info('seo_audit_cycle_completed', { tenantId });
    } catch (err) {
      logger.error('seo_audit_cycle_failed', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  // SEO-5 discovery cycles — same pattern as seo_audit. Silent (no Slack
  // output); the next daily run picks up the opportunities they file.
  if (runKind === 'backlink_prospect') {
    logger.info('backlink_prospect_cycle_starting_from_worker', { tenantId });
    try {
      await runBacklinkProspectCycle(tenantId);
      logger.info('backlink_prospect_cycle_completed_from_worker', { tenantId });
    } catch (err) {
      logger.error('backlink_prospect_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  if (runKind === 'brand_mention_scan') {
    logger.info('brand_mention_scan_cycle_starting_from_worker', { tenantId });
    try {
      await runBrandMentionScanCycle(tenantId);
      logger.info('brand_mention_scan_cycle_completed_from_worker', { tenantId });
    } catch (err) {
      logger.error('brand_mention_scan_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  const trigger: TaskTrigger =
    runKind === 'daily'        ? 'cron-daily'        :
    runKind === 'weekly'       ? 'cron-weekly'       :
    runKind === 'end-of-week'  ? 'cron-end-of-week'  :
    'manual';

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
    // GENERATION-FIRST: agent's job is to populate tomorrow's work pipeline,
    // not to passively report state. The subagent's system prompt
    // (task_intent='daily_generation') has the full playbook + writing-style
    // guide. Keep the user-message short so it doesn't overshadow the system.
    return `Morning generation run for ${clientName}. Find work for the operator to review.

Produce 2-5 concrete changes the operator can approve, plus 3-5 leads for the backlog. Each "change" is something you've already drafted (with a previewable URL), not a vague recommendation. Each lead is a specific opportunity, not a generic suggestion.

Areas to look at: pages worth writing that competitors rank for, internal-linking gaps between existing pages, additive copy or meta improvements on existing pages, and backlink opportunities from competitor analysis. Use what fits today — you don't have to hit every area.

Snapshot today's baseline metrics at some point so we have continuity for tomorrow.`;
  }

  if (kind === 'weekly') {
    // WEEKLY AUDIT: strategic state-of-play. The subagent's system prompt
    // (task_intent='weekly_audit') frames this as the "what happened, what
    // matters, what's next" briefing — not generation. Bigger token budget
    // for deeper analysis.
    return `Weekly strategic audit for ${clientName}. Look back, then look forward.

Cover three things, in this order:

1. What happened this week (shipped work, approved/rejected changes, ranking and traffic deltas, anything unexpected).
2. What it means strategically (is ${clientName}'s position improving, holding, or eroding — vs competitors, vs their own targets, vs the broader category).
3. The top 3 leverage moves for next week — specific enough that the operator can decide yes or no on each.

Risks and red flags belong in section 2. Don't pad with generic recommendations; if the position is fine, say so.`;
  }

  if (kind === 'end-of-week') {
    // END-OF-WEEK DIGEST: friday-afternoon celebration / momentum recap.
    // Designed for the operator to share with their team. Less analytical
    // than the audit, more "look what we did". The subagent's system prompt
    // (task_intent='weekly_digest') has the conversational style guide.
    return `End-of-week digest for ${clientName}. Recap the wins from this week.

Lead with what shipped — be specific, name the pages and the changes, in plain English. Then surface 1-2 numbers that show momentum (rankings up, more pages indexed, traffic delta — whatever's actually moved). Close with a one-line outlook for next week.

Tone is celebratory but honest. If the week was quiet, say so (one sentence). Don't manufacture wins; the operator will know.`;
  }

  // Fallback (unreachable with current RunKind, but TS exhaustiveness).
  return `Scheduled run for ${clientName}. Look at the live state and surface what's worth the operator's attention.`;
}
