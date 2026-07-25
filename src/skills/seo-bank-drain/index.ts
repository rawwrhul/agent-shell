// src/skills/seo-bank-drain/index.ts
//
// The bank_drain cycle: execute the opportunity bank at volume.
//
// Why this exists (2026-07-25): discovery cycles were filing hundreds of
// scored on-page opportunities (hd-seo: 162 metadata_edit + 110 internal_link
// + 133 copy_optimise sitting 'new') while the daily generation run — busy
// drafting its article — drained ~3/day. One internal link shipped in a week
// with 110 banked. This cycle is the missing executor: it takes the top N
// banked items and ships them with ONE bounded, cheap LLM call each, through
// the exact same propose_action gate chain (edit gates, critic, cannibal
// guard, autonomy auto-approve) the agent uses — so quality controls are
// identical, only the orchestration overhead is gone.
//
// v1 is Webflow-only (the drained tenant). Framer tenants log a skip.
// copy_optimise is deliberately excluded: body rewrites deserve the full
// generation agent, not a cheap single call.

import { v4 as uuid } from 'uuid'
import Anthropic from '@anthropic-ai/sdk'
import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import { config } from '../../config'
import { getTenant } from '../../tenants/registry'
import { callAnthropic } from '../../lib/anthropic-call'
import { executeSeoTool } from '../seo/tools'
import type { TenantConfig } from '../../tenants/types'
import {
  resolveBlogFields, getItemBySlug, listBlogItems,
  findPageByPath, getPageMetadata,
} from '../../integrations/webflow/client'

const DRAIN_LIMIT   = Number(process.env.BANK_DRAIN_LIMIT ?? '20')
const META_SHARE    = 12   // of DRAIN_LIMIT
const LINK_SHARE    = 8
// Cheap model for single-shot drafting — these are 60-160 char rewrites and
// anchor selections, not articles. Override via env if quality disappoints.
const DRAIN_MODEL   = process.env.BANK_DRAIN_MODEL ?? 'claude-haiku-4-5-20251001'

export interface BankDrainResult {
  tenantId: string
  picked:   number
  filed:    number
  rejected: number   // gate said no — bank row marked rejected
  skipped:  number   // fetch/draft failure — bank row left 'new' for retry
  errors:   string[]
}

interface BankRow {
  id:        string
  type:      'metadata_edit' | 'internal_link'
  target:    string | null
  rationale: string | null
  detail:    Record<string, unknown> | null
}

export async function runBankDrainCycle(tenantId: string): Promise<BankDrainResult> {
  const runId = uuid()
  const result: BankDrainResult = { tenantId, picked: 0, filed: 0, rejected: 0, skipped: 0, errors: [] }
  logger.info('bank_drain_cycle_starting', { tenantId, runId, limit: DRAIN_LIMIT })

  let tenant: TenantConfig
  try {
    tenant = await getTenant(tenantId)
  } catch {
    result.errors.push('tenant_not_found')
    return result
  }
  if (!tenant.integrations?.includes('webflow')) {
    logger.info('bank_drain_skipped_cms', { tenantId, hint: 'v1 is Webflow-only; extend with a Framer adapter to enable.' })
    result.errors.push('cms_not_supported_v1')
    return result
  }

  const rows = await pickBankRows(tenantId)
  result.picked = rows.length
  if (rows.length === 0) {
    logger.info('bank_drain_nothing_banked', { tenantId })
    return result
  }

  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  const fields = await resolveBlogFields(tenant)
  // Source-post inventory for internal links (name + slug only, one fetch).
  const blogItems = await listBlogItems(tenant, 100).catch(() => [])
  const cmsPrefix = tenant.cmsPathPrefixes?.[0] ?? '/resources/'

  const ctx = {
    tenantId, runId,
    taskId:  `bank-drain-${new Date().toISOString().slice(0, 10)}`,
    trigger: 'cron-bank-drain',   // cron-* => no per-approval Slack cards
  }

  for (const row of rows) {
    try {
      const proposal = row.type === 'metadata_edit'
        ? await draftMetaEdit(anthropic, tenant, fields, cmsPrefix, row)
        : await draftInternalLink(anthropic, tenant, fields, cmsPrefix, blogItems, row)
      if (!proposal) {
        result.skipped++
        continue
      }

      const outcome = await executeSeoTool('propose_action', proposal, ctx)
      // Success shapes (tools.ts): "Approval abcd1234 auto-approved ..." /
      // "Approval abcd1234 filed (...)". Anything else = gate rejection or error.
      if (/^Approval [0-9a-f]{8} (auto-approved|filed)/i.test(outcome.trim())) {
        result.filed++
        await markBankRow(row.id, 'queued', runId)
      } else {
        // Gate rejection (edit gates / cannibal / validation). The verdict is
        // meaningful — don't retry the same item daily.
        result.rejected++
        await markBankRow(row.id, 'rejected', runId)
        logger.info('bank_drain_item_rejected', { tenantId, oppId: row.id, type: row.type, outcome: outcome.slice(0, 200) })
      }
    } catch (err) {
      result.skipped++
      logger.warn('bank_drain_item_failed', { tenantId, oppId: row.id, type: row.type, err: String(err).slice(0, 200) })
    }
  }

  logger.info('bank_drain_cycle_completed', { ...result })
  return result
}

/** Top banked rows by score, with a per-type mix. */
async function pickBankRows(tenantId: string): Promise<BankRow[]> {
  const res = await pool.query(
    `SELECT id, type, target, rationale, detail
     FROM seo_opportunities
     WHERE tenant_id = $1 AND status = 'new' AND type IN ('metadata_edit','internal_link')
     ORDER BY score DESC NULLS LAST, created_at ASC
     LIMIT 120`,
    [tenantId],
  )
  const all = res.rows as BankRow[]
  const meta  = all.filter((r) => r.type === 'metadata_edit').slice(0, META_SHARE)
  const links = all.filter((r) => r.type === 'internal_link').slice(0, LINK_SHARE)
  return [...meta, ...links].slice(0, DRAIN_LIMIT)
}

async function markBankRow(id: string, status: 'queued' | 'rejected', runId: string): Promise<void> {
  await pool.query(
    `UPDATE seo_opportunities SET status = $1, resolved_run_id = $2, updated_at = NOW() WHERE id = $3`,
    [status, runId, id],
  )
}

function pathOf(target: string | null): string {
  if (!target) return ''
  try { return new URL(target).pathname } catch { return target.replace(/^https?:\/\/[^/]+/, '') }
}

function extractJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{'); const e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}

/** One bounded LLM call. maxTokens small — these are tiny structured drafts. */
async function draftOnce(anthropic: Anthropic, prompt: string, label: string): Promise<Record<string, unknown> | null> {
  const resp = await callAnthropic(anthropic, {
    model: DRAIN_MODEL, max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  }, { label, maxRetries: 2 })
  const text = resp.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('')
  return extractJson(text)
}

// ── metadata_edit ──────────────────────────────────────────────────────────

async function draftMetaEdit(
  anthropic: Anthropic, tenant: TenantConfig,
  fields: Awaited<ReturnType<typeof resolveBlogFields>>,
  cmsPrefix: string, row: BankRow,
): Promise<Record<string, unknown> | null> {
  const path = pathOf(row.target)
  const isCms = path.startsWith(cmsPrefix)
  let currentTitle = ''
  let currentDesc  = ''
  let slug = ''

  if (isCms) {
    slug = path.slice(cmsPrefix.length).replace(/\/+$/, '')
    const item = await getItemBySlug(tenant, slug)
    if (!item) return null
    const fd = item.fieldData as Record<string, unknown>
    currentTitle = String(fd[fields.seoTitleField ?? ''] ?? fd[fields.titleField] ?? '')
    currentDesc  = String(fd[fields.seoDescField ?? ''] ?? fd[fields.metaDescField ?? ''] ?? '')
  } else {
    const page = await findPageByPath(tenant, path)
    if (!page) return null
    const meta = await getPageMetadata(tenant, (page as { id: string }).id) as Record<string, unknown>
    const seo = (meta.seo ?? {}) as Record<string, unknown>
    currentTitle = String(seo.title ?? '')
    currentDesc  = String(seo.description ?? '')
  }

  const detail = row.detail ?? {}
  const draft = await draftOnce(anthropic, [
    `You are an SEO copywriter for ${tenant.clientName}, a Sydney Level 2 electrician. Rewrite one page's search-result title and description.`,
    `Page: ${row.target}`,
    `Current title (${currentTitle.length} chars): ${currentTitle || '(empty)'}`,
    `Current description (${currentDesc.length} chars): ${currentDesc || '(empty)'}`,
    `Why this was flagged: ${row.rationale ?? '(no rationale)'}`,
    `Keyword data: ${JSON.stringify(detail).slice(0, 800)}`,
    ``,
    `Rules: title 40-60 chars, leads with the dominant keyword, includes "Sydney" if natural. Description 120-155 chars, specific value statement (no generic blurbs), no truncation risk. Never invent phone numbers or offers.`,
    `Also write operatorSummary: 1-2 plain-English sentences for the client explaining what changed and why (past tense not needed; present-tense proposal voice).`,
    `Return ONLY JSON: {"newTitle": string, "newDescription": string, "operatorSummary": string}`,
  ].join('\n'), 'bank-drain-meta')
  if (!draft || typeof draft.newTitle !== 'string' || typeof draft.newDescription !== 'string') return null

  const toolName = isCms ? 'webflow_update_blog_meta' : 'webflow_update_page_meta'
  const toolInput = isCms
    ? { slug, newTitle: draft.newTitle, newDescription: draft.newDescription }
    : { pagePath: path, newTitle: draft.newTitle, newDescription: draft.newDescription }

  return {
    toolName, toolInput,
    proposedAction: String(draft.operatorSummary ?? `Improve the search listing for ${path}.`),
    riskLevel: 'medium',
  }
}

// ── internal_link ──────────────────────────────────────────────────────────

async function draftInternalLink(
  anthropic: Anthropic, tenant: TenantConfig,
  fields: Awaited<ReturnType<typeof resolveBlogFields>>,
  cmsPrefix: string,
  blogItems: Array<{ fieldData?: Record<string, unknown> }>,
  row: BankRow,
): Promise<Record<string, unknown> | null> {
  const targetPath = pathOf(row.target)
  const detail = row.detail ?? {}
  const keyword = String((detail as { dominant_keyword?: unknown }).dominant_keyword ?? '')

  // Candidate source posts (exclude the target itself).
  const candidates = blogItems
    .map((it) => ({
      name: String(it.fieldData?.[fields.titleField] ?? ''),
      slug: String(it.fieldData?.[fields.slugField] ?? ''),
    }))
    .filter((c) => c.slug && !targetPath.endsWith(`/${c.slug}`))
    .slice(0, 80)
  if (candidates.length === 0) return null

  // Call 1: pick the best source post for a link toward the target.
  const pick = await draftOnce(anthropic, [
    `Pick the ONE blog post most topically related to this under-linked page, to add an internal link FROM.`,
    `Under-linked target page: ${row.target} (topic keyword: "${keyword}")`,
    `Candidate source posts:\n${candidates.map((c) => `- ${c.slug} — ${c.name}`).join('\n')}`,
    `Return ONLY JSON: {"sourceSlug": string}`,
  ].join('\n'), 'bank-drain-link-pick')
  const sourceSlug = typeof pick?.sourceSlug === 'string' ? pick.sourceSlug.trim() : ''
  if (!sourceSlug || !candidates.some((c) => c.slug === sourceSlug)) return null

  const sourceItem = await getItemBySlug(tenant, sourceSlug)
  if (!sourceItem || !fields.bodyField) return null
  const bodyHtml = String((sourceItem.fieldData as Record<string, unknown>)?.[fields.bodyField] ?? '')
  const bodyText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000)
  if (bodyText.length < 200) return null

  // Call 2: choose verbatim anchor text within the source body.
  const anchor = await draftOnce(anthropic, [
    `Choose anchor text for an internal link. From the source text below, select a VERBATIM phrase (3-10 words, exactly as it appears, case-sensitive) that naturally relates to the link target.`,
    `Link target: ${row.target} (topic: "${keyword}")`,
    `Source text: ${bodyText}`,
    `Also write operatorSummary: 1-2 plain-English sentences explaining the link for the client.`,
    `Return ONLY JSON: {"sourceText": string, "operatorSummary": string}`,
  ].join('\n'), 'bank-drain-link-anchor')
  const sourceText = typeof anchor?.sourceText === 'string' ? anchor.sourceText : ''
  // Verbatim guard — the executor will fail on non-verbatim text; catch it here for free.
  if (!sourceText || !bodyHtml.includes(sourceText)) {
    logger.info('bank_drain_anchor_not_verbatim', { sourceSlug, sourceText: sourceText.slice(0, 80) })
    return null
  }

  return {
    toolName: 'webflow_add_internal_link',
    toolInput: { slug: sourceSlug, sourceText, targetUrl: targetPath },
    proposedAction: String(anchor?.operatorSummary ?? `Link "${sourceText}" to ${targetPath}.`),
    riskLevel: 'medium',
  }
}
