// src/agents/quoting/store.ts
//
// CRUD + guarded state transitions for the `quotes` table. The Slack
// conversation is a presenter over these rows; this module is the system of
// record. Binds to the shared pool exported by src/memory/postgres.ts.
//
// State changes go through transitionQuote(), which asserts legality against
// the pure state machine (state-machine.ts) and uses an optimistic guard
// (WHERE state = expectedFrom) so concurrent writers can't corrupt the row.

import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import {
  QuoteState,
  assertTransition,
  IllegalQuoteTransition,
} from './state-machine'
import type {
  LeadIntake,
  QuoteOutline,
  SiteChecklist,
  SiteUpdate,
  QuoteFinal,
} from './schemas'

export interface TranscriptEntry {
  stage:      'lead' | 'site'
  slackFileId: string
  transcript: string
  durationMs?: number
  createdAt:  string
}

export interface QuoteRow {
  id:               string
  tenantId:         string
  state:            QuoteState
  quoteNumber:      string | null
  slackChannelId:   string | null
  slackThreadTs:    string | null
  customerName:     string | null
  customerAddress:  string | null
  customerPhone:    string | null
  jobCategory:      string | null
  jobSubcategory:   string | null
  leadIntake:       LeadIntake | null
  quoteOutline:     QuoteOutline | null
  siteChecklist:    SiteChecklist | null
  siteUpdate:       SiteUpdate | null
  quoteFinal:       QuoteFinal | null
  transcripts:      TranscriptEntry[]
  approvalId:       string | null
  pdfGcsUri:        string | null
  pdfFilename:      string | null
  sentTo:           string | null
  error:            string | null
  createdAt:        Date
  updatedAt:        Date
  sentAt:           Date | null
}

const SELECT_COLS = `
  id,
  tenant_id        AS "tenantId",
  state,
  quote_number     AS "quoteNumber",
  slack_channel_id AS "slackChannelId",
  slack_thread_ts  AS "slackThreadTs",
  customer_name    AS "customerName",
  customer_address AS "customerAddress",
  customer_phone   AS "customerPhone",
  job_category     AS "jobCategory",
  job_subcategory  AS "jobSubcategory",
  lead_intake      AS "leadIntake",
  quote_outline    AS "quoteOutline",
  site_checklist   AS "siteChecklist",
  site_update      AS "siteUpdate",
  quote_final      AS "quoteFinal",
  transcripts,
  approval_id      AS "approvalId",
  pdf_gcs_uri      AS "pdfGcsUri",
  pdf_filename     AS "pdfFilename",
  sent_to          AS "sentTo",
  error,
  created_at       AS "createdAt",
  updated_at       AS "updatedAt",
  sent_at          AS "sentAt"
`

// ── Read ────────────────────────────────────────────────────────────

export async function getQuote(id: string): Promise<QuoteRow | null> {
  const { rows } = await pool.query<QuoteRow>(
    `SELECT ${SELECT_COLS} FROM quotes WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

/** Find the quote a Slack thread belongs to (used to route Stage 2 voice
 *  notes + thread replies to the right quote). */
export async function getQuoteByThread(
  channelId: string,
  threadTs: string,
): Promise<QuoteRow | null> {
  const { rows } = await pool.query<QuoteRow>(
    `SELECT ${SELECT_COLS}
       FROM quotes
      WHERE slack_channel_id = $1 AND slack_thread_ts = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [channelId, threadTs],
  )
  return rows[0] ?? null
}

export async function listQuotesByState(
  tenantId: string,
  state: QuoteState,
): Promise<QuoteRow[]> {
  const { rows } = await pool.query<QuoteRow>(
    `SELECT ${SELECT_COLS}
       FROM quotes
      WHERE tenant_id = $1 AND state = $2
      ORDER BY created_at DESC`,
    [tenantId, state],
  )
  return rows
}

// ── Create ──────────────────────────────────────────────────────────

export interface CreateQuoteInput {
  tenantId:       string
  slackChannelId?: string
  slackThreadTs?:  string
}

export async function createQuote(input: CreateQuoteInput): Promise<QuoteRow> {
  const { rows } = await pool.query<QuoteRow>(
    `INSERT INTO quotes (tenant_id, slack_channel_id, slack_thread_ts)
     VALUES ($1, $2, $3)
     RETURNING ${SELECT_COLS}`,
    [input.tenantId, input.slackChannelId ?? null, input.slackThreadTs ?? null],
  )
  logger.info('quote_created', { quoteId: rows[0].id, tenantId: input.tenantId })
  return rows[0]
}

// ── Patch (no state change) ─────────────────────────────────────────

/** Columns a non-transition patch may set. JSONB payloads are passed as
 *  objects and serialised here. */
export interface QuotePatch {
  quoteNumber?:     string
  slackThreadTs?:   string
  slackChannelId?:  string
  customerName?:    string | null
  customerAddress?: string | null
  customerPhone?:   string | null
  jobCategory?:     string | null
  jobSubcategory?:  string | null
  leadIntake?:      LeadIntake
  quoteOutline?:    QuoteOutline
  siteChecklist?:   SiteChecklist
  siteUpdate?:      SiteUpdate
  quoteFinal?:      QuoteFinal
  approvalId?:      string
  pdfGcsUri?:       string
  pdfFilename?:     string
  sentTo?:          string
  error?:           string | null
}

const PATCH_COLUMN: Record<keyof QuotePatch, { col: string; json?: boolean }> = {
  quoteNumber:     { col: 'quote_number' },
  slackThreadTs:   { col: 'slack_thread_ts' },
  slackChannelId:  { col: 'slack_channel_id' },
  customerName:    { col: 'customer_name' },
  customerAddress: { col: 'customer_address' },
  customerPhone:   { col: 'customer_phone' },
  jobCategory:     { col: 'job_category' },
  jobSubcategory:  { col: 'job_subcategory' },
  leadIntake:      { col: 'lead_intake', json: true },
  quoteOutline:    { col: 'quote_outline', json: true },
  siteChecklist:   { col: 'site_checklist', json: true },
  siteUpdate:      { col: 'site_update', json: true },
  quoteFinal:      { col: 'quote_final', json: true },
  approvalId:      { col: 'approval_id' },
  pdfGcsUri:       { col: 'pdf_gcs_uri' },
  pdfFilename:     { col: 'pdf_filename' },
  sentTo:          { col: 'sent_to' },
  error:           { col: 'error' },
}

function buildPatch(patch: QuotePatch, startIndex: number): {
  sets: string[]
  values: unknown[]
} {
  const sets: string[] = []
  const values: unknown[] = []
  let i = startIndex
  for (const [key, def] of Object.entries(PATCH_COLUMN) as [
    keyof QuotePatch,
    { col: string; json?: boolean },
  ][]) {
    if (!(key in patch)) continue
    const raw = patch[key]
    if (raw === undefined) continue
    sets.push(`${def.col} = $${i}${def.json ? '::jsonb' : ''}`)
    values.push(def.json && raw !== null ? JSON.stringify(raw) : raw)
    i++
  }
  return { sets, values }
}

export async function updateQuote(
  id: string,
  patch: QuotePatch,
): Promise<QuoteRow | null> {
  const { sets, values } = buildPatch(patch, 2)
  if (!sets.length) return getQuote(id)
  const { rows } = await pool.query<QuoteRow>(
    `UPDATE quotes
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLS}`,
    [id, ...values],
  )
  return rows[0] ?? null
}

/** Append a transcript entry to the audit trail without touching state. */
export async function appendTranscript(
  id: string,
  entry: TranscriptEntry,
): Promise<void> {
  await pool.query(
    `UPDATE quotes
        SET transcripts = transcripts || $2::jsonb, updated_at = NOW()
      WHERE id = $1`,
    [id, JSON.stringify([entry])],
  )
}

// ── Transition (state change, optionally with a payload patch) ──────

/**
 * Move a quote to a new state, optionally applying a payload patch in the
 * same write. Asserts the transition is legal against the state machine,
 * then commits with an optimistic guard (WHERE state = expectedFrom). If the
 * row's state changed underneath us, returns null and logs — the caller
 * decides whether that's an error.
 */
export async function transitionQuote(
  id: string,
  to: QuoteState,
  patch: QuotePatch = {},
): Promise<QuoteRow | null> {
  const current = await getQuote(id)
  if (!current) {
    logger.warn('quote_transition_not_found', { quoteId: id, to })
    return null
  }

  try {
    assertTransition(current.state, to)
  } catch (err) {
    if (err instanceof IllegalQuoteTransition) {
      logger.error('quote_illegal_transition', {
        quoteId: id, from: current.state, to,
      })
    }
    throw err
  }

  const { sets, values } = buildPatch(patch, 4)
  const extra = sets.length ? `, ${sets.join(', ')}` : ''

  const { rows } = await pool.query<QuoteRow>(
    `UPDATE quotes
        SET state = $2, updated_at = NOW()${extra}
            ${to === 'SENT' ? ', sent_at = NOW()' : ''}
      WHERE id = $1 AND state = $3
      RETURNING ${SELECT_COLS}`,
    [id, to, current.state, ...values],
  )

  if (!rows.length) {
    logger.warn('quote_transition_lost_race', {
      quoteId: id, expectedFrom: current.state, to,
    })
    return null
  }

  logger.info('quote_transitioned', { quoteId: id, from: current.state, to })
  return rows[0]
}
