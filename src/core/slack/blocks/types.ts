// src/core/slack/blocks/types.ts
//
// Block-Kit-specific types for the new report shapes.
// Domain types live in src/seo/types.ts; this file is purely the
// shape that render functions consume.

import type { KnownBlock } from '@slack/web-api';

export type RunType = 'daily_run' | 'weekly_audit' | 'on_demand';

export interface RenderedMessage {
  /** Fallback text for mobile push notifications + accessibility. Always populate. */
  text: string;
  /** Rich layout. */
  blocks: KnownBlock[];
}

// ── Daily run report ────────────────────────────────────────────────

export interface DailyRunReport {
  tenantName: string;        // "Tarino"
  tenantSlug: string;        // "tarino"
  runId: string;
  runDate: Date;
  trigger: 'cron' | 'on_demand';

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
  id: string;
  title: string;
  detail?: string;
  pendingSince: Date;
  approvalUrl?: string;
}

// ── Weekly audit ────────────────────────────────────────────────────

export interface WeeklyAuditReport {
  tenantName: string;
  tenantSlug: string;
  weekStart: Date;
  trigger: 'cron' | 'on_demand';

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
