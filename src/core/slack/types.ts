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
