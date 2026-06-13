// src/core/slack/blocks/types.ts
//
// Block-Kit-specific types for the report shapes.
// Domain types live in src/seo/types.ts; this file is purely the
// shape that render functions consume.
//
// Rollout 3 additions (additive — existing R2 types preserved):
//   - `tldr: string[]` on DailyRunReport, WeeklyAuditReport, AdHocCheckReport
//   - `AdHocCheckReport` shape for @-mention runs
//   - `FinalReport` union — the structured shape stored on AnchorState.finalReport
//   - Backwards-compat: legacy `finalSummary: string` on AnchorState still works

import type { KnownBlock } from '@slack/web-api';

export type RunType = 'daily_run' | 'weekly_audit' | 'on_demand';

export interface RenderedMessage {
  /** Fallback text for mobile push notifications + accessibility. Always populate. */
  text: string;
  /** Rich layout. */
  blocks: KnownBlock[];
}

// ── Ad-hoc check report (R3 NEW) ────────────────────────────────────
//
// Rendered into the anchor message when an @-mention run completes.
// Replaces the prior thread-reply path.

export interface AdHocCheckReport {
  kind: 'ad_hoc';
  tenantName: string;
  tenantSlug: string;
  runId: string;
  title: string;          // e.g. "Homepage check", "Schema audit"
  subtitle?: string;      // e.g. "tarino.au · 12 pages crawled · 4m 32s"

  /** 3-5 outcome-focused bullets, plain prose. Mandatory. */
  tldr: string[];

  /** Issues / things broken, severity-tagged. */
  broken: BrokenItem[];

  /** Positive findings (1-line each). */
  working: string[];

  /** Top 1-3 highest-leverage moves. */
  leverage: LeverageMove[];
}

export interface BrokenItem {
  severity: 'critical' | 'high' | 'medium' | 'low';
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  text: string;
  meta?: string;          // right-aligned label, e.g. "3 pages" or "P0"
}

export interface LeverageMove {
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  title: string;
  detail: string;
  estImpact: string;      // "+15% est. CTR" or "—"
}

// ── Daily run report ────────────────────────────────────────────────

export interface DailyRunReport {
  kind: 'daily';
  tenantName: string;        // "Tarino"
  tenantSlug: string;        // "tarino"
  runId: string;
  runDate: Date;
  trigger: 'cron' | 'on_demand';

  /** R3: 3-5 bullets summarising overnight + queued + awaiting. */
  tldr: string[];

  /** Deterministic performance pulse (computed in SQL, never by the LLM).
   *  Stamped by the presenter at completeRun; absent until history exists. */
  performancePulse?: string;

  shippedActions: ShippedAction[];
  newOpportunities: Opportunity[];
  queuedForToday: QueuedAction[];
  awaitingApproval: ApprovalItem[];

  nextRunAt?: Date;          // null means no scheduled next run
  workspaceUrl?: string;     // link to the work log / Sheets / wherever
}

export interface ShippedAction {
  id: string;
  title: string;
  detail?: string;
  executedAt: Date;
  status: 'success' | 'partial';
}

export interface Opportunity {
  id: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
}

export interface QueuedAction {
  id: string;
  title: string;
  estimateMinutes?: number;
}

export interface ApprovalItem {
  id: string;                 // approval_requests.id (UUID)
  title: string;
  detail?: string;
  pendingSince: Date;
  severity?: 'critical' | 'high' | 'medium' | 'low';
}

// ── Weekly audit ────────────────────────────────────────────────────

export interface WeeklyAuditReport {
  kind: 'weekly';
  tenantName: string;
  tenantSlug: string;
  weekStart: Date;
  trigger: 'cron' | 'on_demand';

  /** R3: 3-5 strategic bullets summarising the week. */
  tldr: string[];

  summary: AuditSummary;
  stateOfPlay: MetricField[];
  topPriorities: Priority[];
  clusterProgress: ClusterStatus[];
  riskFlags: RiskFlag[];

  approvalQueueCount: number;
  nextAuditAt?: Date;
  workspaceUrl?: string;
}

export interface AuditSummary {
  actionsShipped: number;
  clusterBriefsLanded: number;
  rankingsImproved: number;
  riskFlags: number;
}

export interface MetricField {
  label: string;             // "Indexed pages"
  value: string;             // "14"
  delta?: string;            // "+3 vs last wk"
  deltaDirection?: 'up' | 'down' | 'flat';
}

export interface Priority {
  rank: 'P0' | 'P1' | 'P2';
  title: string;
  detail?: string;
  impact: 'high' | 'med' | 'low';
}

export interface ClusterStatus {
  pillarTopic: string;
  state: 'planned' | 'in_progress' | 'complete';
  briefsLanded: number;
  briefsTotal: number;
  awaitingPublish: number;
  detail?: string;
}

export interface RiskFlag {
  title: string;
  detail?: string;
  severity: 'monitor' | 'act_soon' | 'urgent';
}

// ── FinalReport union (R3 NEW) ──────────────────────────────────────

/**
 * The structured shape stored on AnchorState.finalReport when a run
 * completes. The anchor renderer (renderAnchor) inspects `kind` and
 * delegates to the matching report renderer.
 */
// ── Phase 9a: Tight ad-hoc response shape ───────────────────────────
//
// Used for Slack-mention runs that produce a single, focused output (e.g.
// "draft me a blog post"). Avoids the TL;DR/broken/working/leverage
// structure that makes sense for daily reports but reads as clinical
// overkill for a one-off task. The approval card carries the meaningful
// next action — the anchor just needs a short summary and a 'why'.
export interface AdHocTightReport {
  kind: 'ad_hoc_tight';
  tenantName: string;
  tenantSlug: string;
  runId: string;

  /** Short title for the run. e.g. "Drafted: Time zone objection post". */
  title: string;

  /** One sentence — what got done. Past tense, action-first. */
  summary: string;

  /** One sentence — why this matters for the business. */
  why: string;

  /** 0-2 optional context bullets. Most runs leave this empty. */
  notes?: string[];
}

export type FinalReport = AdHocCheckReport | AdHocTightReport | DailyRunReport | WeeklyAuditReport;
