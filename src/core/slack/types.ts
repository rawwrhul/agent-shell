// src/core/slack/types.ts
//
// Shared types for the Slack presenter. Kept dependency-free so render.ts
// (which is pure) can import them without dragging in pg, slack, etc.
//
// Rollout 3: RunState.finalReport widens from a single literal shape
// `{ summaryText, fullLength, threadedTs? }` to a union that also includes
// the structured FinalReport. Legacy completed runs still render via the
// summaryText path; new completed runs carry the structured report which
// the anchor renderer delegates on.

import type { FinalReport } from './blocks/types';

export type RunPhase =
  | 'starting'
  | 'planning'
  | 'running'
  | 'synthesising'
  | 'complete'
  | 'failed';

export type SpecialistState =
  | { status: 'queued';   spawnedAt: number }
  | { status: 'running';  startedAt: number; lastNote?: string }
  | { status: 'complete'; startedAt: number; completedAt: number; summary: string; tokenCount: number }
  | { status: 'failed';   startedAt: number; failedAt: number; error: string };

export interface SpecialistEntry {
  type:       string;
  name:       string;
  scopedTask: string;
  state:      SpecialistState;
}

/**
 * R3: union of legacy summary or structured FinalReport.
 *
 * - `{ summaryText, fullLength, threadedTs? }` — legacy R1/R2 shape.
 *   Pre-R3 completed runs in the DB still have this; preserved for
 *   backward compat.
 * - `{ kind: 'ad_hoc' | 'daily' | 'weekly', ... }` — structured shape.
 *   New R3 completed runs carry this; rendered inline in the anchor.
 *
 * Discriminate on `kind`: present means structured, absent means legacy.
 */
export type RunFinalReport =
  | (FinalReport & { renderedInAnchor: true })
  | { summaryText: string; fullLength: number; threadedTs?: string };

export interface RunState {
  taskId:      string;
  tenantId:    string;
  agentType:   string;
  clientName:  string;
  prompt:      string;
  channelId:   string;
  startedAt:   number;
  phase:       RunPhase;
  revision:    number;
  planSummary?: string;
  specialists: Record<string, SpecialistEntry>;
  finalReport?: RunFinalReport;
  errorSummary?: string;
}

export interface StartRunInput {
  taskId:     string;
  tenantId:   string;
  agentType:  string;
  clientName: string;
  prompt:     string;
  channelId:  string;
}

export interface ApprovalRequestInput {
  tenantId:   string;
  channelId:  string;
  taskId:     string;
  toolName:   string;
  riskLevel:  string;
  riskReason: string;
  approvalId: string;
  /** Task 0.5: optional preview URL (Framer draft staging URL).
   *  Renders as a clickable "View preview ↗" link in the approval card. */
  previewUrl?: string;
  /** Task 0.5.1: human-readable tenant name for the headline (e.g. "Tarino").
   *  Falls back to tenantId if omitted, which reads worse ("tarino"). */
  tenantName?: string;
  /** Task 0.5.1: one-line, plain-English summary for the card body.
   *  Typically the propose_action's proposedAction field, written in
   *  customer-facing voice. Falls back to a CLI-style tool-name banner. */
  summary?: string;
  /** Task 0.5.1: explicit action kind for icon + button label. Falls
   *  back to inferred from toolName, else 'other'. */
  actionKind?: 'publish_content' | 'modify_live_page' | 'send_external_message' | 'commit_data_change' | 'other';
}

export interface ApprovalResolvedInput {
  tenantId:   string;
  channelId:  string;
  taskId:     string;
  toolName:   string;
  approvalId: string;
  decision:   'approved' | 'rejected' | 'timeout';
  resolvedBy?:        string;
  rejectionReason?:   string;
}

/**
 * Task 0.5.1: pending-too-long nudge. Posted by the daily nudge scanner
 * when a tenant has approvals sitting unresolved past the threshold.
 * One message per tenant per cooldown window (default 24h).
 */
export interface PendingNudgeInput {
  tenantId:        string;
  channelId:       string;
  tenantName:      string;
  pendingCount:    number;
  oldestDaysAgo:   number;
}

/**
 * Task 0.5.1: posted after the executor worker has actually carried out
 * an approved action. The operator approves the Slack card → executor
 * worker calls the integration → this message tells the operator what
 * happened (success: change is live; failure: here's the error).
 *
 * Without this loop, the experience after Approve is "card resolves to
 * Approved by X, then silence" — operator can't tell if the change
 * actually shipped. With it, the loop closes.
 */
export interface ExecutionResultInput {
  tenantId:    string;
  channelId:   string;
  taskId:      string;
  approvalId:  string;
  toolName:    string;
  ok:          boolean;
  /** One-line plain-English summary. Success: what changed.
   *  Failure: what went wrong (short, customer-facing). */
  summary:     string;
  /** Optional live URL operator can click to see the change. */
  liveUrl?:    string;
  /** Optional human-readable tenant name for the header. */
  tenantName?: string;
}

export interface BudgetWarningInput {
  tenantId:    string;
  channelId:   string;
  taskId:      string;
  clientName:  string;
  spent:       number;
  cap:         number;
}

export class RunNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`No slack_runs row for taskId=${taskId} — did you call startRun?`);
    this.name = 'RunNotFoundError';
  }
}

/**
 * R3: type guard. Returns true if the report is the structured shape
 * (rendered inline in anchor) rather than legacy summary.
 */
export function isStructuredReport(r: RunFinalReport): r is FinalReport & { renderedInAnchor: true } {
  return 'kind' in r;
}
