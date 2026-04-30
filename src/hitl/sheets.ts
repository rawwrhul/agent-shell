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

export async function createApprovalRequest(
  tenant: TenantConfig,
  params: { taskId: string; sessionId: string; toolName: string; toolInput: Record<string,unknown>; riskLevel: string; riskReason: string }
): Promise<string> {
  const id = uuid()
  await sheets(tenant).spreadsheets.values.append({
    spreadsheetId: tenant.hitlSpreadsheetId,
    range:         `${tenant.hitlSheetName}!A:L`,
    valueInputOption: 'RAW',
    requestBody: { values: [[
      id, params.taskId, params.sessionId, params.toolName,
      JSON.stringify(params.toolInput, null, 2),
      params.riskLevel.toUpperCase(), params.riskReason,
      new Date().toISOString(), 'pending', '', '', '',
    ]] },
  })
  logger.info('hitl_request_written', { tenantId: tenant.tenantId, id, tool: params.toolName })
  return id
}

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
