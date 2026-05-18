// src/skills/seo-backlink-prospector/store.ts
//
// DB helpers for the backlink prospector. Owns:
//   - upserting inventory rows (our active inbound backlinks)
//   - reading existing referring-domain set (so we can diff)
//   - filing seo_opportunities + outreach_queue rows for prospects

import { v4 as uuid } from 'uuid'
import { pool } from '../../memory/postgres'
import type { InventoryBacklinkRow, BacklinkProspect } from './types'

/**
 * Upsert one inventory row (active backlink). Stamps last_seen to NOW.
 * Status defaults to 'active' on insert; existing 'lost'/'toxic' status
 * is preserved on update.
 */
export async function upsertInventoryRow(input: {
  tenantId:    string
  targetUrl:   string
  row:         InventoryBacklinkRow
}): Promise<{ inserted: boolean }> {
  const result = await pool.query<{ inserted: boolean }>(
    `INSERT INTO seo.backlink_inventory (
       tenant_id, target_url, source_url, source_domain,
       anchor_text, source_dr, dofollow, status, first_seen, last_seen
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())
     ON CONFLICT (tenant_id, source_url, target_url) DO UPDATE
       SET last_seen     = NOW(),
           anchor_text   = COALESCE(EXCLUDED.anchor_text, seo.backlink_inventory.anchor_text),
           source_dr     = COALESCE(EXCLUDED.source_dr,   seo.backlink_inventory.source_dr),
           dofollow      = EXCLUDED.dofollow
     RETURNING (xmax = 0) AS inserted`,
    [
      input.tenantId, input.targetUrl, input.row.sourceUrl,
      input.row.sourceDomain, input.row.anchorText, input.row.sourceDr,
      input.row.dofollow,
    ],
  )
  return { inserted: result.rows[0]?.inserted ?? false }
}

/**
 * Return the set of referring domains we already have at least one
 * active link from. Used to diversify prospect selection.
 */
export async function getReferringDomainSet(tenantId: string): Promise<Set<string>> {
  const r = await pool.query<{ source_domain: string }>(
    `SELECT DISTINCT source_domain
     FROM seo.backlink_inventory
     WHERE tenant_id = $1
       AND status = 'active'`,
    [tenantId],
  )
  return new Set(r.rows.map((row) => row.source_domain))
}

/**
 * File a single prospect: insert an outreach_queue row + seo_opportunities
 * row, linked. Returns both IDs.
 */
export async function fileProspectAsOpportunity(input: {
  tenantId:       string
  runId:          string
  prospect:       BacklinkProspect
  draft:          { subject: string; body: string; pitchAngle: string } | null
}): Promise<{ opportunityId: string; outreachQueueId: string }> {
  const opportunityId = uuid()
  const outreachQueueId = uuid()

  const description =
    `Get a backlink from ${input.prospect.sourceDomain} (DR ${input.prospect.sourceDr ?? '?'})`
  const rationale =
    `${input.prospect.rationale} Currently links to ${input.prospect.competitorDomain}; anchor text "${input.prospect.anchorText ?? '(none)'}"`

  // detail JSONB carries the rich prospect + draft for the daily run's
  // surface renderer + the approval card.
  const detail = {
    prospect_type:        'backlink_gap',
    source_url:           input.prospect.sourceUrl,
    source_domain:        input.prospect.sourceDomain,
    source_dr:            input.prospect.sourceDr,
    anchor_text:          input.prospect.anchorText,
    competitor_target:    input.prospect.competitorTargetUrl,
    competitor_domain:    input.prospect.competitorDomain,
    prospect_score:       input.prospect.prospectScore,
    drafted_subject:      input.draft?.subject ?? null,
    drafted_body:         input.draft?.body ?? null,
    pitch_angle:          input.draft?.pitchAngle ?? null,
    recipient_email_field: 'TO_BE_PROVIDED_BY_OPERATOR',
    mailto_url:           buildMailto({
      subject: input.draft?.subject ?? `Quick question about ${input.prospect.sourceDomain}`,
      body:    input.draft?.body ?? '',
    }),
    outreach_queue_id:    outreachQueueId,
  }

  // outreach_queue row first (FK target).
  await pool.query(
    `INSERT INTO seo.outreach_queue (
       id, tenant_id, opportunity_id, prospect_type, target_site,
       target_url_idea, pitch_angle,
       drafted_subject, drafted_body, contact_email, status,
       created_at, drafted_at
     ) VALUES ($1, $2, $3, 'backlink_gap', $4, $5, $6, $7, $8, NULL,
               $9, NOW(), $10)
     ON CONFLICT (tenant_id, target_site) DO NOTHING`,
    [
      outreachQueueId, input.tenantId, opportunityId,
      input.prospect.sourceDomain, input.prospect.sourceUrl,
      input.draft?.pitchAngle ?? null,
      input.draft?.subject ?? null,
      input.draft?.body ?? null,
      input.draft ? 'drafted' : 'queued',
      input.draft ? new Date() : null,
    ],
  )

  // Opportunity row second.
  const priority = input.prospect.prospectScore >= 0.7 ? 'P1' : 'P2'
  await pool.query(
    `INSERT INTO seo_opportunities (
       id, tenant_id, run_id, type, target,
       description, rationale, priority, status,
       estimated_impact, detail, created_at, updated_at
     ) VALUES ($1, $2, $3, 'pursue_backlink', $4, $5, $6, $7, 'new',
               $8, $9, NOW(), NOW())`,
    [
      opportunityId, input.tenantId, input.runId, input.prospect.sourceDomain,
      description, rationale, priority,
      `DR ${input.prospect.sourceDr ?? '?'} referring domain`,
      JSON.stringify(detail),
    ],
  )

  return { opportunityId, outreachQueueId }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildMailto(input: { subject: string; body: string }): string {
  const params = new URLSearchParams({
    subject: input.subject,
    body:    input.body,
  })
  // mailto: takes the recipient before the `?`. Recipient placeholder is
  // left as `RECIPIENT_EMAIL` for the operator to substitute.
  return `mailto:RECIPIENT_EMAIL?${params.toString()}`
}
