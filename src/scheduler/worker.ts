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
import type { TenantConfig } from '../tenants/types'
import { runFullAuditCycle } from '../skills/seo-technical-auditor';
import { runBacklinkProspectCycle } from '../skills/seo-backlink-prospector';
import { runBrandMentionScanCycle } from '../skills/seo-brand-mention-monitor';
import { runStrategyRefreshCycle } from '../core/strategy/refresh';
import { runMetadataEditCycle } from '../skills/seo-discovery';
import { runCopyOptimiseCycle, runInternalLinkCycle } from '../skills/seo-discovery';
import { runArticleCreateCycle } from '../skills/seo-discovery';
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

  // metrics_sync is a pure data job (GSC + GA4 → history tables) — no
  // orchestrator, no LLM. Daily-run agents consume the stored history.
  if (runKind === 'metrics_sync') {
    const { runMetricsSyncCycle } = await import('../core/metrics/sync');
    try {
      await runMetricsSyncCycle(tenantId);
    } catch (err) {
      logger.error('metrics_sync_cycle_failed', { tenantId, err: String(err).slice(0, 400) });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
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

  // strategy_refresh authors/refreshes the per-tenant strategy doc. Silent
  // (no Slack); discovery cycles + the daily run consume it. Freshness-guarded
  // inside the cycle for effective fortnightly cadence.
  if (runKind === 'strategy_refresh') {
    logger.info('strategy_refresh_cycle_starting_from_worker', { tenantId });
    try {
      await runStrategyRefreshCycle(tenantId);
      logger.info('strategy_refresh_cycle_completed_from_worker', { tenantId });
    } catch (err) {
      logger.error('strategy_refresh_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  // metadata_edit discovery cycle (Phase 2, unit 3). Silent: scores and files
  // CTR-gap opportunities into the bank for the daily run to surface. No Slack.
  if (runKind === 'metadata_edit') {
    logger.info('metadata_edit_cycle_starting_from_worker', { tenantId });
    try {
      const r = await runMetadataEditCycle(tenantId);
      logger.info('metadata_edit_cycle_completed_from_worker', {
        tenantId, candidates: r.candidates, filed: r.filed, skipped: r.skipped,
      });
    } catch (err) {
      logger.error('metadata_edit_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  // copy_optimise discovery cycle (Phase 2, unit 3). Silent: files scored
  // striking-distance content opportunities into the bank. No Slack.
  if (runKind === 'copy_optimise') {
    logger.info('copy_optimise_cycle_starting_from_worker', { tenantId });
    try {
      const r = await runCopyOptimiseCycle(tenantId);
      logger.info('copy_optimise_cycle_completed_from_worker', {
        tenantId, candidates: r.candidates, filed: r.filed, skipped: r.skipped,
      });
    } catch (err) {
      logger.error('copy_optimise_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  // internal_link discovery cycle (Phase 2, unit 3). Silent: files scored
  // under-linked-page opportunities into the bank. Crawl-gated. No Slack.
  if (runKind === 'internal_link') {
    logger.info('internal_link_cycle_starting_from_worker', { tenantId });
    try {
      const r = await runInternalLinkCycle(tenantId);
      logger.info('internal_link_cycle_completed_from_worker', {
        tenantId, candidates: r.candidates, filed: r.filed, skipped: r.skipped,
      });
    } catch (err) {
      logger.error('internal_link_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  // article_create discovery cycle (Phase 2, unit 3). Silent: files scored
  // new-content opportunities for underserved strategy clusters. No Slack.
  if (runKind === 'article_create') {
    logger.info('article_create_cycle_starting_from_worker', { tenantId });
    try {
      const r = await runArticleCreateCycle(tenantId);
      logger.info('article_create_cycle_completed_from_worker', {
        tenantId, candidates: r.candidates, filed: r.filed, skipped: r.skipped,
      });
    } catch (err) {
      logger.error('article_create_cycle_failed_from_worker', {
        tenantId, err: String(err).slice(0, 500),
      });
    }
    await recordScheduleFired(tenantId, runKind, new Date());
    return;
  }

  const trigger: TaskTrigger =
    runKind === 'daily'        ? 'cron-daily'        :
    runKind === 'daily_pm'     ? 'cron-daily'        :
    runKind === 'weekly'       ? 'cron-weekly'       :
    runKind === 'end-of-week'  ? 'cron-end-of-week'  :
    'manual';

  const task = await enqueueTask({
    tenantId,
    agentType:      tenant.agentType,
    prompt:         buildPromptForRunKind(runKind, tenant),
    slackChannelId: tenant.slackChannelId,
    slackUserId:    '_cron_',
    trigger,
  });

  await recordScheduleFired(tenantId, runKind, new Date());

  logger.info('schedule_run_enqueued', {
    tenantId, runKind, trigger, taskId: task.id,
  });
}

function buildPromptForRunKind(kind: RunKind, tenant: TenantConfig): string {
  const clientName = tenant.clientName
  if (kind === 'daily' || kind === 'daily_pm') {
    // GENERATION-FIRST: agent's job is to populate tomorrow's work pipeline,
    // not to passively report state. The subagent's system prompt
    // (task_intent='daily_generation') has the full playbook + writing-style
    // guide. Keep the user-message short so it doesn't overshadow the system.
    const runLabel = kind === 'daily_pm' ? 'Afternoon' : 'Morning'

    // Autonomous tenants: two generation runs a day, each bounded to ONE
    // article + 4-6 secondary actions. Actions execute automatically after
    // the Surfer quality gate — no operator approval step.
    if (tenant.autonomyLevel === 'full') {
      return `${runLabel} generation run for ${clientName} (AUTONOMOUS tenant — approved actions execute automatically; there is no human approval step for API-executable work).

Your job is DRAFTING, not DISCOVERY. Background runs already populated the opportunity bank — do not re-run audits, do not re-fetch competitor backlinks, do not re-scan for brand mentions.

What to produce this run (in priority order):

1. ONE new blog post on a topic gap, filed via propose_action with toolName='approve_blog_pitch' (two-stage flow; the Surfer quality gate decides publish). Do NOT attempt a second post — the token budget will not support it; the other daily run covers the second article.
${kind === 'daily_pm' ? '   IMPORTANT: check approval_requests for today before picking a topic — the morning run already filed one post. Pick a DIFFERENT topic/cluster.\n' : ''}
2. 4-6 on-page improvements for existing pages. Pick the right tool based on what you're changing:
   - Blog meta (title/description) → framer_update_blog_meta, toolInput={ slug, newTitle?, newDescription? }
   - Blog body refresh or content additions → framer_update_blog_body, toolInput={ slug, newContent }
   - Blog image alt text → framer_add_blog_alt_text, toolInput={ slug, newAltText }
   - Internal link inside a blog post body → framer_add_internal_link, toolInput={ slug, sourceText, targetUrl }
   - Marketing page body text (About/Contact/etc) → framer_update_marketing_page_text, toolInput={ pagePath, oldText, newText }
   - Site-wide JSON-LD schema → framer_add_site_schema, toolInput={ schemaId, jsonLd }
   - Marketing page meta / robots.txt / sitemap / canonicals / per-page noindex / NEW LANDING PAGES → manual_operator_task with precise Framer-UI instructions (these still require the operator — genuine API limits).

Every propose_action you file for an API-executable tool ships within minutes. Quality bar stays exactly as high as HITL mode: read the page before you change it, no speculative edits, no churn on pages changed in the last 7 days (check approval_requests + seo_work_log first — do NOT redo or undo recent work).

3. Refine bank outreach drafts if one needs work (manual_operator_task — operator still sends outreach).

Snapshot today's baseline metrics at some point so we have continuity.`;
    }

    return `${runLabel} generation run for ${clientName}.

Your job today is DRAFTING, not DISCOVERY. Background runs already populated the opportunity bank with audit findings, backlink prospects, and unlinked brand mentions — the aggregator will surface those automatically from seo_opportunities into this run's Slack post. Do not re-run audits, do not re-fetch competitor backlinks, do not re-scan for brand mentions. Those are already done and waiting in the table.

What to draft inline this run (in priority order):

1. ONE new blog post on a topic gap. Find a keyword cluster competitors rank for that ${clientName} doesn't have a page for, draft the full post, file via propose_action with toolName='approve_blog_pitch' (two-stage pitch → publish flow). This is the primary deliverable.

2. 2-3 quick on-page improvements for existing pages. Pick the right tool based on what you're changing:
   - Blog meta (title/description) → framer_update_blog_meta, toolInput={ slug, newTitle?, newDescription? }
   - Blog body refresh or content additions → framer_update_blog_body, toolInput={ slug, newContent }
   - Blog image alt text → framer_add_blog_alt_text, toolInput={ slug, newAltText }
   - Internal link inside a blog post body → framer_add_internal_link, toolInput={ slug, sourceText, targetUrl }
   - Marketing page body text (About/Contact/etc) → framer_update_marketing_page_text, toolInput={ pagePath, oldText, newText }
   - Site-wide JSON-LD schema → framer_add_site_schema, toolInput={ schemaId, jsonLd }
   - Marketing page meta / robots.txt / sitemap / canonicals / per-page noindex → manual_operator_task with precise Framer-UI instructions (these are genuine API limits, not gaps).

3. Refine bank outreach drafts if you spot one that needs work. The backlink_prospector skill drafts a generic pitch for each prospect; if you can write a stronger version for a specific high-value target, do so and file via propose_action with toolName='manual_operator_task' explaining the upgrade.

Keep the run bounded: one blog post + 2-3 quick fixes + maybe one outreach refinement. Do NOT attempt multiple blog posts in a single run; the token budget will not support it. Lean on the bank for everything that's already been discovered.

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
