// src/scheduler/types.ts
//
// Types for the per-tenant cron scheduling layer.

// 'daily_pm' — second daily generation run for high-velocity autonomous
// tenants. Same behaviour as 'daily' (generation prompt, cron-daily trigger);
// separate run_kind because tenant_schedules PK is (tenant_id, run_kind) so
// one tenant can't hold two 'daily' rows. Two bounded runs, not one double
// run: a single run can't fit two full article drafts in the token budget.
// 'outcome_score' — deterministic ship→measure→policy loop: scores executed
// approvals against GSC deltas (page vs site control) and writes win/loss
// memories the generation runs consume. Silent, no LLM, no Slack.
// 'daily_digest' — deterministic end-of-day record (actions + links,
// articles, discards, outcomes, GSC summary) written to daily_digests.
// DB-only; sends nothing.
// 'keyword_gap' — origination layer: Ahrefs competitor organic keywords
// diffed against our GSC surface -> seo.keyword_gap. Feeds strategy refresh
// (attack clusters) and copy/meta discovery (secondary targeting). Silent.
export type RunKind = 'daily' | 'daily_pm' | 'weekly' | 'end-of-week' | 'seo_audit' | 'backlink_prospect' | 'brand_mention_scan' | 'metrics_sync' | 'strategy_refresh' | 'metadata_edit' | 'copy_optimise' | 'internal_link' | 'article_create' | 'outcome_score' | 'daily_digest' | 'keyword_gap'

export interface TenantSchedule {
  tenantId:    string
  runKind:     RunKind
  cronExpr:    string                    // e.g. '0 9 * * *' for 9am daily
  timezone:    string                    // IANA tz e.g. 'Australia/Sydney'
  enabled:     boolean
  lastFiredAt: Date | null
  createdAt:   Date
  updatedAt:   Date
}

export interface ScheduledRunPayload {
  tenantId:   string
  runKind:    RunKind
  triggerAt:  string                     // ISO timestamp of the scheduled fire time
  scheduleId: string                     // primary key from tenant_schedules
}

// ── Repeatable-job config ──────────────────────────────────────────────────

export const SCHEDULE_QUEUE_NAME = 'scheduled-runs'

/** BullMQ repeatable-job options derived from a TenantSchedule. */
export interface RepeatableJobOpts {
  jobId:    string                       // stable id so reschedule replaces, not duplicates
  cron:     string
  timezone: string
}

export function repeatableJobIdFor(schedule: TenantSchedule): string {
  return `${schedule.tenantId}__${schedule.runKind}`
}
