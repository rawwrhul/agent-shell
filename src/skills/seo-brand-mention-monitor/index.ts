// src/skills/seo-brand-mention-monitor/index.ts
//
// SEO-5 brand mention monitor. Weekly cron. Scans the SERP for the
// tenant's brand name + close variants, cross-references each result
// against seo.backlink_inventory, and files `fix_unlinked_mention`
// opportunities for sites that mentioned us but didn't link.
//
// Single-file skill — smaller scope than the backlink prospector.

import { v4 as uuid } from 'uuid'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import type { TenantConfig } from '../../tenants/types'
import { serpOrganicLive } from '../../integrations/dataforseo/client'
import { pool } from '../../memory/postgres'
import { canProspect } from '../../core/outreach-safety'
import { draftOutreach } from '../../core/outreach-drafter'

// ── Result type ─────────────────────────────────────────────────────────

export interface MentionScanResult {
  tenantId:               string
  queriesRun:             number
  serpResultsReviewed:    number
  mentionsRecorded:       number
  alreadyLinked:          number   // had a backlink → skipped
  candidatesAfterSafety:  number
  opportunitiesFiled:     number
  draftsGenerated:        number
  errors:                 string[]
}

// ── Heuristics ──────────────────────────────────────────────────────────

const MAX_MENTIONS_PER_CYCLE = 10
const SERP_DEPTH = 20

// ── Entry ───────────────────────────────────────────────────────────────

export async function runBrandMentionScanCycle(tenantId: string): Promise<MentionScanResult> {
  const runId = uuid()
  logger.info('brand_mention_scan_cycle_starting', { tenantId, runId })

  let tenant: TenantConfig
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    logger.error('brand_mention_scan_tenant_load_failed', {
      tenantId, err: String(err).slice(0, 200),
    })
    return emptyResult(tenantId, [`tenant_not_found_${tenantId}`])
  }

  // Opt-out check.
  if ((tenant.disabledOpportunityTypes ?? []).includes('fix_unlinked_mention')) {
    logger.info('brand_mention_scan_skipped_disabled', { tenantId })
    return emptyResult(tenantId, [])
  }

  const targetDomain = tenant.targetDomain ?? ''
  if (!targetDomain) {
    logger.warn('brand_mention_scan_skipped_no_domain', { tenantId })
    return emptyResult(tenantId, ['no_target_domain_configured'])
  }

  const result: MentionScanResult = {
    tenantId,
    queriesRun:             0,
    serpResultsReviewed:    0,
    mentionsRecorded:       0,
    alreadyLinked:          0,
    candidatesAfterSafety:  0,
    opportunitiesFiled:     0,
    draftsGenerated:        0,
    errors:                 [],
  }

  // Build brand queries. Use clientName and quoted clientName so SERP
  // returns mentions, not other pages of the same name.
  const queries = buildBrandQueries(tenant.clientName, targetDomain)

  // Existing referring domains — fast set membership.
  const linkedDomains = await getActiveReferringDomainSet(tenantId)

  // Collect candidates across queries.
  const seenSourceUrls = new Set<string>()
  const candidates: Array<{
    sourceUrl: string; sourceDomain: string;
    title: string; description: string
  }> = []

  for (const q of queries) {
    try {
      const items = await serpOrganicLive(tenant, { keyword: q, depth: SERP_DEPTH })
      result.queriesRun++

      for (const item of items) {
        result.serpResultsReviewed++

        // Skip our own pages and our subdomains.
        if (item.domain === targetDomain) continue
        if (item.domain.endsWith('.' + targetDomain)) continue
        // Skip if already seen in another query.
        if (seenSourceUrls.has(item.url)) continue
        seenSourceUrls.add(item.url)

        // Skip if we have a backlink from this domain (already linked).
        if (linkedDomains.has(item.domain)) {
          result.alreadyLinked++
          continue
        }

        candidates.push({
          sourceUrl:    item.url,
          sourceDomain: item.domain,
          title:        item.title,
          description:  item.description,
        })
      }
    } catch (err) {
      result.errors.push(`serp_query_failed_${q}: ${String(err).slice(0, 100)}`)
      logger.warn('brand_mention_serp_query_failed', {
        tenantId, query: q, err: String(err).slice(0, 200),
      })
    }
  }

  // Cap candidates before per-prospect work.
  const top = candidates.slice(0, MAX_MENTIONS_PER_CYCLE)

  // Persist + safety + draft + file.
  for (const c of top) {
    // Record the mention (idempotent on UNIQUE constraint).
    try {
      await recordMention({
        tenantId,
        sourceUrl:    c.sourceUrl,
        sourceDomain: c.sourceDomain,
        context:      c.description.slice(0, 500),
      })
      result.mentionsRecorded++
    } catch (err) {
      result.errors.push(`record_mention_failed_${c.sourceDomain}`)
      continue
    }

    // Safety gate.
    let safety: Awaited<ReturnType<typeof canProspect>>
    try {
      safety = await canProspect({
        tenantId, targetSite: c.sourceDomain,
      })
    } catch (err) {
      result.errors.push(`safety_check_failed_${c.sourceDomain}`)
      continue
    }
    if (!safety.allowed) {
      logger.info('brand_mention_blocked_by_safety', {
        tenantId, sourceDomain: c.sourceDomain, reason: safety.reason,
      })
      continue
    }
    result.candidatesAfterSafety++

    // Draft.
    let draft: Awaited<ReturnType<typeof draftOutreach>> | null = null
    try {
      draft = await draftOutreach({
        businessBrief: tenant.businessBrief,
        prospectType: 'unlinked_mention',
        targetSite:   c.sourceDomain,
        targetUrl:    c.sourceUrl,
        tenantName:   tenant.clientName,
        tenantDomain: targetDomain,
        ourUrl:       null,
        context:
          `${c.sourceDomain} published this page mentioning ${tenant.clientName} but without a backlink to us. ` +
          `Page title: "${c.title}". Excerpt: "${c.description}".`,
      })
      if (draft) result.draftsGenerated++
    } catch (err) {
      logger.warn('brand_mention_draft_failed', {
        tenantId, sourceDomain: c.sourceDomain,
        err: String(err).slice(0, 200),
      })
    }

    // File.
    try {
      await fileMentionAsOpportunity({
        tenantId, runId,
        sourceUrl:    c.sourceUrl,
        sourceDomain: c.sourceDomain,
        title:        c.title,
        excerpt:      c.description,
        draft,
      })
      result.opportunitiesFiled++
    } catch (err) {
      result.errors.push(`file_failed_${c.sourceDomain}`)
      logger.warn('brand_mention_file_failed', {
        tenantId, sourceDomain: c.sourceDomain,
        err: String(err).slice(0, 200),
      })
    }
  }

  logger.info('brand_mention_scan_cycle_completed', result)
  return result
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildBrandQueries(clientName: string, domain: string): string[] {
  const queries: string[] = []
  queries.push(`"${clientName}"`)
  // Domain-mention search (without protocol).
  queries.push(`"${domain}"`)
  // Strip TLD for a looser variant.
  const root = domain.split('.')[0]
  if (root && root.length > 3 && root !== clientName.toLowerCase()) {
    queries.push(`"${root}"`)
  }
  return queries
}

async function getActiveReferringDomainSet(tenantId: string): Promise<Set<string>> {
  const r = await pool.query<{ source_domain: string }>(
    `SELECT DISTINCT source_domain
     FROM seo.backlink_inventory
     WHERE tenant_id = $1
       AND status = 'active'`,
    [tenantId],
  )
  return new Set(r.rows.map((row) => row.source_domain))
}

async function recordMention(input: {
  tenantId:     string
  sourceUrl:    string
  sourceDomain: string
  context:      string
}): Promise<void> {
  await pool.query(
    `INSERT INTO seo.brand_mentions (
       tenant_id, source_url, source_domain, mention_context,
       has_backlink, status, detected_at
     ) VALUES ($1, $2, $3, $4, FALSE, 'open', NOW())
     ON CONFLICT (tenant_id, source_url) DO UPDATE
       SET mention_context = COALESCE(EXCLUDED.mention_context, seo.brand_mentions.mention_context),
           detected_at = NOW()`,
    [input.tenantId, input.sourceUrl, input.sourceDomain, input.context],
  )
}

async function fileMentionAsOpportunity(input: {
  tenantId:     string
  runId:        string
  sourceUrl:    string
  sourceDomain: string
  title:        string
  excerpt:      string
  draft:        Awaited<ReturnType<typeof draftOutreach>> | null
}): Promise<void> {
  const opportunityId = uuid()
  const outreachQueueId = uuid()

  const description = `Get a link from ${input.sourceDomain} — they mentioned us but didn't link`
  const rationale = `Page "${input.title.slice(0, 80)}" mentions the brand. Reachable via "${input.excerpt.slice(0, 120)}..."`

  const detail = {
    prospect_type:         'unlinked_mention',
    source_url:            input.sourceUrl,
    source_domain:         input.sourceDomain,
    source_title:          input.title,
    source_excerpt:        input.excerpt,
    drafted_subject:       input.draft?.subject ?? null,
    drafted_body:          input.draft?.body ?? null,
    pitch_angle:           input.draft?.pitchAngle ?? null,
    recipient_email_field: 'TO_BE_PROVIDED_BY_OPERATOR',
    mailto_url:            buildMailto({
      subject: input.draft?.subject ?? `Quick note about your piece on ${input.sourceDomain}`,
      body:    input.draft?.body ?? '',
    }),
    outreach_queue_id:     outreachQueueId,
  }

  await pool.query(
    `INSERT INTO seo.outreach_queue (
       id, tenant_id, opportunity_id, prospect_type, target_site,
       target_url_idea, pitch_angle, drafted_subject, drafted_body,
       status, created_at, drafted_at
     ) VALUES ($1, $2, $3, 'unlinked_mention', $4, $5, $6, $7, $8,
               $9, NOW(), $10)
     ON CONFLICT (tenant_id, target_site) DO NOTHING`,
    [
      outreachQueueId, input.tenantId, opportunityId,
      input.sourceDomain, input.sourceUrl,
      input.draft?.pitchAngle ?? null,
      input.draft?.subject ?? null,
      input.draft?.body ?? null,
      input.draft ? 'drafted' : 'queued',
      input.draft ? new Date() : null,
    ],
  )

  await pool.query(
    `INSERT INTO seo_opportunities (
       id, tenant_id, run_id, type, target,
       description, rationale, priority, status,
       estimated_impact, detail, created_at, updated_at
     ) VALUES ($1, $2, $3, 'fix_unlinked_mention', $4, $5, $6, 'P1', 'new',
               $7, $8, NOW(), NOW())`,
    [
      opportunityId, input.tenantId, input.runId, input.sourceDomain,
      description, rationale,
      'warm prospect (already mentioned)',
      JSON.stringify(detail),
    ],
  )

  // Mark the mention row as queued for outreach.
  await pool.query(
    `UPDATE seo.brand_mentions
     SET status = 'outreach_queued'
     WHERE tenant_id = $1
       AND source_url = $2
       AND status = 'open'`,
    [input.tenantId, input.sourceUrl],
  )
}

function buildMailto(input: { subject: string; body: string }): string {
  const params = new URLSearchParams({
    subject: input.subject, body: input.body,
  })
  return `mailto:RECIPIENT_EMAIL?${params.toString()}`
}

function emptyResult(tenantId: string, errors: string[]): MentionScanResult {
  return {
    tenantId,
    queriesRun:             0,
    serpResultsReviewed:    0,
    mentionsRecorded:       0,
    alreadyLinked:          0,
    candidatesAfterSafety:  0,
    opportunitiesFiled:     0,
    draftsGenerated:        0,
    errors,
  }
}
