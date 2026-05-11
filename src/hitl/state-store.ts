// src/hitl/state-store.ts
//
// CRUD helpers for the approval_requests table. Aligned with the actual
// R1-created schema:
//   id               UUID PRIMARY KEY DEFAULT uuid_generate_v4()
//   tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id)
//   task_id          TEXT NOT NULL
//   session_id       TEXT (nullable as of R3)
//   tool_name        TEXT NOT NULL
//   tool_input       JSONB NOT NULL
//   risk_level       TEXT NOT NULL
//   risk_reason      TEXT NOT NULL
//   status           TEXT NOT NULL DEFAULT 'pending'
//   requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   resolved_at      TIMESTAMPTZ
//   resolved_by      TEXT
//   rejection_reason TEXT
//   priority         TEXT NOT NULL DEFAULT 'P1'           -- R3
//   proposed_action  TEXT                                  -- R3
//   detail           JSONB NOT NULL DEFAULT '[]'           -- R3
//   why_priority     TEXT                                  -- R3
//   slack_channel_id TEXT                                  -- R3
//   slack_message_ts TEXT                                  -- R3
//   sheet_row_number INT                                   -- R3
//   defer_until      TIMESTAMPTZ                           -- R3
//   updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()    -- R3

import type { Pool } from 'pg';
import { logger } from '../logger';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'deferred' | 'expired';
export type ApprovalPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ApprovalRiskLevel = 'low' | 'medium' | 'high';

export interface ApprovalRow {
  id:               string;        // UUID
  tenantId:         string;
  taskId:           string;
  sessionId:        string | null;
  toolName:         string;
  toolInput:        Record<string, unknown>;
  riskLevel:        string;        // historical: free-form text; new rows use ApprovalRiskLevel
  riskReason:       string;
  status:           ApprovalStatus;
  requestedAt:      Date;
  resolvedAt:       Date | null;
  resolvedBy:       string | null;
  rejectionReason:  string | null;
  // R3 columns
  priority:         ApprovalPriority;
  proposedAction:   string | null;
  detail:           string[];
  whyPriority:      string | null;
  slackChannelId:   string | null;
  slackMessageTs:   string | null;
  sheetRowNumber:   number | null;
  deferUntil:       Date | null;
  updatedAt:        Date;
}

const SELECT_COLS = `
  id,
  tenant_id         AS "tenantId",
  task_id           AS "taskId",
  session_id        AS "sessionId",
  tool_name         AS "toolName",
  tool_input        AS "toolInput",
  risk_level        AS "riskLevel",
  risk_reason       AS "riskReason",
  status,
  requested_at      AS "requestedAt",
  resolved_at       AS "resolvedAt",
  resolved_by       AS "resolvedBy",
  rejection_reason  AS "rejectionReason",
  priority,
  proposed_action   AS "proposedAction",
  detail,
  why_priority      AS "whyPriority",
  slack_channel_id  AS "slackChannelId",
  slack_message_ts  AS "slackMessageTs",
  sheet_row_number  AS "sheetRowNumber",
  defer_until       AS "deferUntil",
  updated_at        AS "updatedAt"
`;

// ── Read ────────────────────────────────────────────────────────────

export async function getApproval(pool: Pool, approvalId: string): Promise<ApprovalRow | null> {
  const { rows } = await pool.query<ApprovalRow>(
    `SELECT ${SELECT_COLS} FROM approval_requests WHERE id = $1`,
    [approvalId],
  );
  return rows[0] ?? null;
}

export async function listPendingApprovals(pool: Pool, tenantId: string): Promise<ApprovalRow[]> {
  const { rows } = await pool.query<ApprovalRow>(
    `SELECT ${SELECT_COLS}
     FROM approval_requests
     WHERE tenant_id = $1
       AND status = 'pending'
       AND (defer_until IS NULL OR defer_until <= NOW())
     ORDER BY priority ASC, requested_at ASC`,
    [tenantId],
  );
  return rows;
}

// ── Write ───────────────────────────────────────────────────────────

export interface CreateApprovalInput {
  tenantId:         string;
  taskId:           string;
  sessionId?:       string;
  toolName:         string;
  toolInput:        Record<string, unknown>;
  riskLevel:        ApprovalRiskLevel;
  riskReason:       string;
  // R3 fields (optional — defaulted server-side or in code)
  priority?:        ApprovalPriority;
  proposedAction?:  string;
  detail?:          string[];
  whyPriority?:     string;
  slackChannelId?:  string;
  slackMessageTs?:  string;
  sheetRowNumber?:  number;
}

export async function createApproval(pool: Pool, input: CreateApprovalInput): Promise<ApprovalRow> {
  const { rows } = await pool.query<ApprovalRow>(
    `INSERT INTO approval_requests (
       tenant_id, task_id, session_id, tool_name, tool_input,
       risk_level, risk_reason, priority, proposed_action, detail,
       why_priority, slack_channel_id, slack_message_ts, sheet_row_number
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14
     )
     RETURNING ${SELECT_COLS}`,
    [
      input.tenantId,
      input.taskId,
      input.sessionId ?? null,
      input.toolName,
      JSON.stringify(input.toolInput),
      input.riskLevel,
      input.riskReason,
      input.priority ?? 'P1',
      input.proposedAction ?? null,
      JSON.stringify(input.detail ?? []),
      input.whyPriority ?? null,
      input.slackChannelId ?? null,
      input.slackMessageTs ?? null,
      input.sheetRowNumber ?? null,
    ],
  );
  logger.info('approval_created', {
    approvalId: rows[0].id, tenantId: input.tenantId, priority: rows[0].priority,
  });
  return rows[0];
}

export async function recordSlackMessageTs(
  pool: Pool, approvalId: string, channelId: string, messageTs: string,
): Promise<void> {
  await pool.query(
    `UPDATE approval_requests
     SET slack_channel_id = $2, slack_message_ts = $3, updated_at = NOW()
     WHERE id = $1`,
    [approvalId, channelId, messageTs],
  );
}

export interface ResolveApprovalInput {
  approvalId:       string;
  decision:         'approved' | 'rejected' | 'deferred' | 'expired';
  resolvedBy:       string;        // slack user id, or '_system_' for timeouts
  rejectionReason?: string;
  deferUntil?:      Date;          // only relevant when decision === 'deferred'
}

export async function resolveApproval(
  pool: Pool, input: ResolveApprovalInput,
): Promise<ApprovalRow | null> {
  // For 'deferred' we DON'T set status to 'deferred' — we keep it 'pending'
  // and set defer_until. The daily-run query filters those out until the
  // defer_until time passes. Defer is reversible; approved/rejected are terminal.
  const isDefer = input.decision === 'deferred';

  const { rows } = await pool.query<ApprovalRow>(
    isDefer
      ? `UPDATE approval_requests
         SET defer_until = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING ${SELECT_COLS}`
      : `UPDATE approval_requests
         SET
           status            = $2,
           resolved_by       = $3,
           resolved_at       = NOW(),
           rejection_reason  = $4,
           updated_at        = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING ${SELECT_COLS}`,
    isDefer
      ? [input.approvalId, input.deferUntil ?? new Date(Date.now() + 24*60*60*1000)]
      : [input.approvalId, input.decision, input.resolvedBy, input.rejectionReason ?? null],
  );

  if (rows.length === 0) {
    logger.warn('approval_resolve_no_op', {
      approvalId: input.approvalId, decision: input.decision,
      hint: 'already resolved or non-existent',
    });
    return null;
  }
  logger.info('approval_resolved', {
    approvalId: input.approvalId, decision: input.decision, resolvedBy: input.resolvedBy,
  });
  return rows[0];
}
