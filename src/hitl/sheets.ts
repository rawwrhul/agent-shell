// src/hitl/sheets.ts
//
// Google Sheets is the PERSISTENT AUDIT RECORD for HITL approvals.
// Postgres (approval_requests table) is the OPERATIONAL state — Slack
// button clicks update PG, agent polls PG. This file mirrors approvals
// into the tenant's Sheet at request time and at resolution time so the
// Sheet always reflects current state. Sheet edits made directly do NOT
// flow back to PG yet (that requires a separate sync mechanism; see
// AGENT-TODO).
//
// R3.1 changes:
//   - createApprovalRequest accepts an optional `id` so PG and Sheet
//     share the same approval ID
//   - new updateApprovalRowStatus mirrors resolution decisions back to
//     the Sheet so the persistent record stays accurate
//   - createApprovalRequest now returns { id, rowNumber } so callers can
//     record the row number on the PG row for fast subsequent updates
//   - The legacy waitForApproval (Sheets-polling) is kept for any caller
//     that still uses it, but new code should use state-store.ts:
//     waitForApprovalResolution which polls PG

import { google } from 'googleapis'
import { v4 as uuid } from 'uuid'
import { TenantConfig } from '../tenants/types'
import { logger } from '../logger'

const COL = { ID:0, TASK:1, SESSION:2, TOOL:3, INPUT:4, RISK:5, REASON:6, REQUESTED:7, STATUS:8, RESOLVED_AT:9, BY:10, REJECT:11 }
const POLL = 15_000

function sheets(tenant: TenantConfig) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: tenant.googleSaEmail,
      private_key:  tenant.googlePrivateKey.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

export interface CreateApprovalRequestResult {
  id:         string
  rowNumber:  number | null   // 1-indexed Sheet row, or null if API didn't return it
}

export async function createApprovalRequest(
  tenant: TenantConfig,
  params: {
    /** Optional pre-generated ID. When omitted, a fresh UUID is created.
     *  Callers writing to PG should pass the PG row's ID so the two stay
     *  in sync. */
    id?:         string
    taskId:      string
    sessionId:   string
    toolName:    string
    toolInput:   Record<string,unknown>
    riskLevel:   string
    riskReason:  string
  }
): Promise<CreateApprovalRequestResult> {
  const id = params.id ?? uuid()
  const response = await sheets(tenant).spreadsheets.values.append({
    spreadsheetId: tenant.hitlSpreadsheetId,
    range:         `${tenant.hitlSheetName}!A:L`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      id, params.taskId, params.sessionId, params.toolName,
      JSON.stringify(params.toolInput, null, 2),
      params.riskLevel.toUpperCase(), params.riskReason,
      new Date().toISOString(), 'pending', '', '', '',
    ]] },
  })
  logger.info('hitl_request_written', { tenantId: tenant.tenantId, id, tool: params.toolName })

  // Extract the inserted row number from the updatedRange (e.g. "Sheet1!A47:L47" → 47)
  const updatedRange = response.data.updates?.updatedRange ?? ''
  const rowMatch = updatedRange.match(/!A(\d+):/)
  const rowNumber = rowMatch ? parseInt(rowMatch[1], 10) : null

  return { id, rowNumber }
}

/**
 * Legacy Sheets-polling wait function. Kept for backwards compatibility
 * with any caller that still uses the Sheets-as-truth flow. New code
 * should use state-store.waitForApprovalResolution instead — it polls
 * PG (where Slack clicks land) and is ~10x faster.
 *
 * @deprecated Use state-store.waitForApprovalResolution
 */
export async function waitForApproval(
  tenant: TenantConfig,
  approvalId: string,
  timeoutMs: number
): Promise<{ status: 'approved'|'rejected'; resolvedBy: string; rejectionReason?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(POLL)
    const res = await sheets(tenant).spreadsheets.values.get({
      spreadsheetId: tenant.hitlSpreadsheetId,
      range:         `${tenant.hitlSheetName}!A:L`,
    })
    const row = (res.data.values ?? []).find(r => r[COL.ID] === approvalId)
    if (!row) continue
    const status = String(row[COL.STATUS] ?? '').toLowerCase()
    if (status === 'approved' || status === 'rejected') {
      return { status: status as 'approved'|'rejected', resolvedBy: String(row[COL.BY] ?? ''), rejectionReason: String(row[COL.REJECT] ?? '') }
    }
  }
  throw new Error(`Approval ${approvalId} timed out`)
}

/**
 * R3.1 — Mirror a resolution decision back to the Sheet so the persistent
 * record stays accurate after a Slack button click.
 *
 * Best-effort: any failure is logged and swallowed. The PG row remains
 * authoritative and the agent is already unblocked by the time this runs.
 *
 * Updates columns STATUS / RESOLVED_AT / BY / REJECT. Uses
 * sheet_row_number for direct address when available; otherwise scans the
 * sheet for the matching ID (slower but always works).
 */
export async function updateApprovalRowStatus(
  tenant: TenantConfig,
  params: {
    approvalId:       string
    rowNumber:        number | null   // 1-indexed Sheet row; null → scan
    status:           'approved' | 'rejected' | 'deferred'
    resolvedBy:       string
    rejectionReason?: string
  },
): Promise<void> {
  try {
    const api = sheets(tenant)
    let rowNumber = params.rowNumber

    if (rowNumber == null) {
      // Fallback: scan the sheet for the matching ID
      const res = await api.spreadsheets.values.get({
        spreadsheetId: tenant.hitlSpreadsheetId,
        range:         `${tenant.hitlSheetName}!A:A`,
      })
      const idx = (res.data.values ?? []).findIndex(r => r[0] === params.approvalId)
      if (idx === -1) {
        logger.warn('hitl_sheet_row_not_found', {
          tenantId: tenant.tenantId, approvalId: params.approvalId,
        })
        return
      }
      rowNumber = idx + 1 // values are 0-indexed; Sheets rows are 1-indexed
    }

    // Update columns I-L (STATUS, RESOLVED_AT, BY, REJECT)
    await api.spreadsheets.values.update({
      spreadsheetId: tenant.hitlSpreadsheetId,
      range:         `${tenant.hitlSheetName}!I${rowNumber}:L${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          params.status,
          new Date().toISOString(),
          params.resolvedBy,
          params.rejectionReason ?? '',
        ]],
      },
    })

    logger.info('hitl_sheet_mirrored', {
      tenantId: tenant.tenantId, approvalId: params.approvalId,
      status: params.status, rowNumber,
    })
  } catch (err) {
    logger.warn('hitl_sheet_mirror_failed', {
      tenantId: tenant.tenantId, approvalId: params.approvalId,
      err: String(err).slice(0, 200),
    })
  }
}

export async function ensureHeaders(tenant: TenantConfig) {
  const api = sheets(tenant)
  const res = await api.spreadsheets.values.get({
    spreadsheetId: tenant.hitlSpreadsheetId,
    range:         `${tenant.hitlSheetName}!A1`,
  })
  if (!res.data.values?.length) {
    await api.spreadsheets.values.update({
      spreadsheetId: tenant.hitlSpreadsheetId,
      range:         `${tenant.hitlSheetName}!A1:L1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['ID','Task ID','Session ID','Tool Name','Tool Input','Risk Level','Risk Reason','Requested At','Status (pending/approved/rejected)','Resolved At','Resolved By','Rejection Reason']] },
    })
    logger.info('hitl_headers_created', { tenantId: tenant.tenantId })
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
