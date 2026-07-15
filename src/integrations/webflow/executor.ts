// src/integrations/webflow/executor.ts
//
// Handlers for approved Webflow actions — the Webflow mirror of
// framer/executor.ts, dispatched via src/execution/dispatcher.ts.
//
// HARD RULE (learned in production): Webflow writes can return 200 and
// silently not persist. EVERY executor here re-reads after writing and
// compares. A write that didn't stick returns ok:false with a loud summary —
// never a silent success. This is what makes day-one autonomy on a client
// site defensible.
//
// Two-stage blog flow mirrors Framer:
//   approve_blog_pitch (routed here for Webflow tenants) → Surfer quality
//   pipeline → create DRAFT CMS item → Stage 2 'webflow_confirm_publish'
//   (auto-approved when autonomous + gate passed) → publish item live.

import { logger } from '../../logger'
import { onPublishSucceeded, onPublishFailed } from '../../memory/pipeline-events'
import type { IntegrationContext, ExecutionResult } from '../types'
import { createApproval } from '../../hitl/state-store'
import { pool } from '../../memory/postgres'
import { presenter } from '../../core/slack'
import { getRun } from '../../core/slack/state-store'
import { scoreAndMaybeRevise, qualityGateForAutonomousPublish } from '../surfer/revision'
import { isFullyAutonomous, autoApproveAndExecute } from '../../hitl/autonomy'
import { enrichArticleHtml, matchByTokenOverlap } from '../content-enrich'
import * as wf from './client'

/** Blog-template parity: resolve services/category/tag reference fields by
 *  deterministic name-token overlap against the article title+keyword.
 *  Fail-open — missing refs never block a publish. */
async function resolveTemplateRefs(
  tenant: Parameters<typeof wf.resolveBlogRefFields>[0],
  matchText: string,
): Promise<Record<string, unknown>> {
  const extra: Record<string, unknown> = {}
  try {
    const refs = await wf.resolveBlogRefFields(tenant)
    for (const [slug, collectionId] of Object.entries(refs.multiRefs)) {
      const candidates = await wf.listCollectionItemNames(tenant, collectionId).catch(() => [])
      const maxPicks = slug.includes('categor') ? 1 : 3
      const picks = matchByTokenOverlap(matchText, candidates, maxPicks)
      if (picks.length > 0) extra[slug] = picks
    }
    for (const [slug, options] of Object.entries(refs.options)) {
      const picks = matchByTokenOverlap(matchText, options, 1)
      if (picks.length > 0) extra[slug] = picks[0]
    }
  } catch (err) {
    logger.warn('webflow_template_refs_failed', { tenantId: tenant.tenantId, err: String(err).slice(0, 160) })
  }
  return extra
}

// ── shared verify helper ────────────────────────────────────────────────────

async function verifyItemFields(
  ctx: IntegrationContext, itemId: string, expected: Record<string, unknown>,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const item = await wf.getItemById(ctx.tenant, itemId)
  const mismatches: string[] = []
  for (const [field, want] of Object.entries(expected)) {
    const got = item.fieldData[field]
    const gotStr  = typeof got === 'object' && got !== null ? JSON.stringify(got) : String(got ?? '')
    const wantStr = typeof want === 'object' && want !== null ? JSON.stringify(want) : String(want ?? '')
    if (typeof want === 'object' && want !== null && 'alt' in (want as Record<string, unknown>)) {
      // Image fields: only the alt is what we assert (URL may be re-hosted by Webflow).
      const gotAlt = (got as Record<string, unknown> | null)?.alt ?? ''
      const wantAlt = (want as Record<string, unknown>).alt ?? ''
      if (String(gotAlt) !== String(wantAlt)) mismatches.push(`${field}.alt: wanted '${wantAlt}', got '${gotAlt}'`)
    } else if (gotStr !== wantStr) {
      mismatches.push(`${field}: write did not persist (got ${gotStr.slice(0, 80)}…)`)
    }
  }
  return { ok: mismatches.length === 0, mismatches }
}

function silentFailure(action: string, mismatches: string[]): ExecutionResult {
  return {
    ok: false,
    summary: `${action} FAILED VERIFICATION: Webflow returned success but the change did not persist (known Webflow behaviour). Mismatches: ${mismatches.join('; ')}. Needs manual attention in the Webflow designer.`,
    error: `webflow_silent_write_failure: ${mismatches.join('; ')}`,
  }
}

// ── webflow_confirm_publish (Stage 2) ───────────────────────────────────────

export interface WfConfirmPublishInput {
  itemId: string
  slug?:  string
  title?: string
}

export async function execWebflowConfirmPublish(
  input: WfConfirmPublishInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.itemId) {
    return { ok: false, summary: 'webflow_confirm_publish error: itemId required', error: 'missing itemId' }
  }
  const slug = input.slug ?? ''
  try {
    await wf.publishItems(ctx.tenant, [input.itemId])

    // Verify: item must no longer be a draft and must carry a publish stamp.
    const item = await wf.getItemById(ctx.tenant, input.itemId)
    if (item.isDraft || !item.lastPublished) {
      const msg = `publish did not take effect (isDraft=${item.isDraft}, lastPublished=${item.lastPublished})`
      void onPublishFailed({ tenantId: ctx.tenant.tenantId, slug, error: msg })
      return { ok: false, summary: `webflow_confirm_publish FAILED VERIFICATION: ${msg}`, error: msg }
    }

    const url = wf.productionUrl(ctx.tenant, wf.blogPath(ctx.tenant, slug || String(item.fieldData.slug ?? '')))
    void onPublishSucceeded({
      tenantId: ctx.tenant.tenantId, slug: slug || String(item.fieldData.slug ?? ''),
      title: input.title, productionUrl: url,
    })
    return {
      ok: true,
      summary: `Published '${input.title ?? slug}' live → ${url} (verified: item is live).`,
      detail: { itemId: input.itemId, slug, productionUrl: url },
    }
  } catch (err) {
    void onPublishFailed({ tenantId: ctx.tenant.tenantId, slug, error: String(err).slice(0, 200) })
    return { ok: false, summary: `webflow_confirm_publish failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── webflow_rollback_draft ──────────────────────────────────────────────────

export interface WfRollbackDraftInput { itemId: string; slug?: string }

export async function execWebflowRollbackDraft(
  input: WfRollbackDraftInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.itemId) {
    return { ok: false, summary: 'webflow_rollback_draft error: itemId required', error: 'missing itemId' }
  }
  try {
    await wf.deleteItem(ctx.tenant, input.itemId)
    return { ok: true, summary: `Draft ${input.slug ?? input.itemId} removed from Webflow CMS.` }
  } catch (err) {
    return { ok: false, summary: `webflow_rollback_draft failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── approve_blog_pitch (Stage 1, Webflow route) ─────────────────────────────

export interface WfApproveBlogPitchInput {
  slug:            string
  title:           string
  content:         string          // HTML for the RichText body field
  imageUrl?:       string
  whyThisTopic?:   string
  targetKeyword?:  string
  metaTitle?:      string          // agent-authored SEO title (listing card + SERP)
  metaDescription?: string         // agent-authored SEO description (listing card + SERP)
}

export async function execWebflowApproveBlogPitch(
  input: WfApproveBlogPitchInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || !input.title || !input.content) {
    return { ok: false, summary: 'approve_blog_pitch error: slug, title, content all required',
             error: 'missing required field in toolInput' }
  }
  try {
    const autonomous = isFullyAutonomous(ctx.tenant)

    // Quality pass — same contract as the Framer route.
    let draftContent: string
    let reviewNote: string | undefined
    let gatePassed = false
    if (autonomous) {
      const gate = await qualityGateForAutonomousPublish({
        model:   ctx.tenant.agentModel,
        keyword: input.targetKeyword ?? input.title,
        content: input.content,
      })
      logger.info('surfer_autonomous_quality_gate', {
        cms: 'webflow', slug: input.slug, available: gate.available, passed: gate.passed,
        scoreBefore: gate.scoreBefore, scoreAfter: gate.scoreAfter,
        aiDetected: gate.aiDetected, humanized: gate.humanized, revised: gate.revised, note: gate.note,
      })
      if (!gate.passed) {
        void onPublishFailed({
          tenantId: ctx.tenant.tenantId, slug: input.slug,
          error: `autonomous quality gate: ${gate.note}`,
        })
        return {
          ok: false,
          summary: `Article '${input.title}' discarded — ${gate.note}. No draft created. Next run should retry with a different angle or topic.`,
          error: gate.note,
          detail: { slug: input.slug, autonomous: true, discarded: true,
                    scoreBefore: gate.scoreBefore, scoreAfter: gate.scoreAfter, threshold: gate.threshold },
        }
      }
      draftContent = gate.content
      reviewNote   = gate.note
      gatePassed   = gate.passed
    } else {
      const revision = await scoreAndMaybeRevise({
        model:   ctx.tenant.agentModel,
        keyword: input.targetKeyword ?? input.title,
        content: input.content,
      })
      draftContent = revision.content
      reviewNote   = revision.note
    }

    // Post-gate enrichment: byline + in-body Pexels images. Runs AFTER
    // scoring so the gate judged the words, and the polish never distorts
    // the verdict. Fails open.
    draftContent = await enrichArticleHtml({
      tenant: ctx.tenant, title: input.title,
      keyword: input.targetKeyword ?? input.title, content: draftContent,
    }).catch(() => draftContent)

    // Create the DRAFT CMS item with mapped fields.
    const map = await wf.resolveBlogFields(ctx.tenant)
    if (!map.bodyField) {
      return { ok: false, summary: 'approve_blog_pitch error: could not resolve a RichText body field on the Webflow blog collection',
               error: 'webflow_body_field_unresolved' }
    }

    // Blog-template parity: category/services/tag refs + summary/meta fields,
    // so agent posts render like human posts on the listing page (2026-07-14:
    // missing blog-category showed "No items found." chips on the live blog).
    const refFields = await resolveTemplateRefs(ctx.tenant, `${input.title} ${input.targetKeyword ?? ''}`)
    // Summary crop EXCLUDES the enrichment byline (learned live: a byline-led
    // card description reads as a formatting bug on the listing page).
    const plainText = draftContent
      .replace(/<p><em>Written by[\s\S]*?<\/em><\/p>/i, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const summary = plainText.length > 220 ? `${plainText.slice(0, 217).replace(/\s+\S*$/, '')}…` : plainText

    const fieldData: Record<string, unknown> = {
      ...refFields,
      [map.titleField]: input.title,
      [map.slugField]:  input.slug.trim().replace(/^\/+|\/+$/g, ''),
      [map.bodyField]:  draftContent,
    }
    if (map.metaDescField && !fieldData[map.metaDescField]) fieldData[map.metaDescField] = summary
    // SEO/listing fields (the blog card renders meta-description). Prefer
    // the agent-AUTHORED values from the pitch; derive only as fallback.
    const seoDesc = input.metaDescription?.trim()
      || (summary.length > 158 ? `${summary.slice(0, 155).replace(/\s+\S*$/, '')}…` : summary)
    if (map.seoTitleField && !fieldData[map.seoTitleField]) {
      fieldData[map.seoTitleField] = (input.metaTitle?.trim() || input.title).slice(0, 70)
    }
    if (map.seoDescField && !fieldData[map.seoDescField]) fieldData[map.seoDescField] = seoDesc
    if (input.imageUrl && map.imageField) {
      fieldData[map.imageField] = { url: input.imageUrl, alt: input.title }
    }
    // Slug idempotency (2026-07-15: a retried pitch job created THREE items —
    // Webflow auto-suffixes duplicate slugs, putting -2/-3 copies live).
    // If an item with this slug already exists, UPDATE it instead of creating.
    const existing = await wf.getItemBySlug(ctx.tenant, input.slug).catch(() => null)
    const draft = existing
      ? await wf.updateItemFields(ctx.tenant, existing.id, fieldData)
      : await wf.createDraftItem(ctx.tenant, fieldData)
    if (existing) {
      logger.info('webflow_pitch_reused_existing_item', {
        tenantId: ctx.tenant.tenantId, slug: input.slug, itemId: existing.id,
      })
    }
    if (!draft.id) {
      return { ok: false, summary: 'approve_blog_pitch error: Webflow draft creation returned no item id',
               error: 'webflow_draft_create_no_id' }
    }

    const stage1ApprovalId = ctx.approvalId
    if (!stage1ApprovalId) {
      return { ok: false, summary: 'approve_blog_pitch error: missing Stage 1 approvalId in context',
               error: 'ctx.approvalId is undefined; cannot link Stage 2 back' }
    }

    const prodUrl = wf.productionUrl(ctx.tenant, wf.blogPath(ctx.tenant, input.slug))
    const stage2 = await createApproval(pool, {
      tenantId:        ctx.tenant.tenantId,
      taskId:          ctx.taskId,
      toolName:        'webflow_confirm_publish',
      toolInput:       { itemId: draft.id, slug: input.slug, title: input.title } as Record<string, unknown>,
      riskLevel:       'high',
      riskReason:      `Will publish the drafted post live to ${ctx.tenant.targetDomain ?? 'the production site'}.`,
      priority:        'P1',
      proposedAction:  `Publish '${input.title}' to ${wf.blogPath(ctx.tenant, input.slug)}`,
      whyPriority:     input.whyThisTopic ?? 'Draft ready for review in the Webflow designer.',
      slackChannelId:  null as unknown as string | undefined,
      previewUrl:      prodUrl,
      parentApprovalId: stage1ApprovalId,
    })

    if (autonomous && gatePassed) {
      const auto = await autoApproveAndExecute(pool, {
        approvalId:     stage2.id,
        tenantId:       ctx.tenant.tenantId,
        toolName:       'webflow_confirm_publish',
        toolInput:      { itemId: draft.id, slug: input.slug, title: input.title },
        proposedAction: `Publish '${input.title}' to ${wf.blogPath(ctx.tenant, input.slug)}`,
      })
      if (auto.approved) {
        return {
          ok: true,
          summary: `Webflow draft created; Stage 2 auto-approved (autonomous, ${reviewNote ?? 'quality gate passed'}) — publish ${auto.enqueued ? 'queued' : `not enqueued: ${auto.reason}`}.`,
          detail: { itemId: draft.id, slug: input.slug, stage2ApprovalId: stage2.id,
                    productionUrl: prodUrl, autonomous: true, qualityNote: reviewNote },
        }
      }
      logger.warn('autonomous_stage2_fallthrough_to_hitl', {
        cms: 'webflow', slug: input.slug, stage2ApprovalId: stage2.id, reason: auto.reason,
      })
    }

    // HITL card (normal path for hitl tenants; rescue path for autonomous).
    const run = await getRun(pool, ctx.taskId)
    const channelId = run?.channelId ?? ctx.tenant.slackChannelId
    if (channelId) {
      try {
        await presenter.requestApproval({
          tenantId:   ctx.tenant.tenantId,
          channelId,
          taskId:     ctx.taskId,
          toolName:   'webflow_confirm_publish',
          riskLevel:  'high',
          riskReason: autonomous
            ? 'Autonomous publish RESCUE: quality gate passed but auto-approve failed. Approve to publish.'
            : 'Publishes the drafted post to the live site.',
          approvalId: stage2.id,
          previewUrl: prodUrl,
          tenantName: ctx.tenant.clientName,
          summary:    reviewNote
            ? `Publish '${input.title}' · ${reviewNote}`
            : `Publish '${input.title}'`,
        })
      } catch { /* card post is best-effort; DB row is authoritative */ }
    }

    return {
      ok: true,
      summary: `Webflow draft created. Stage 2 card posted (approval id ${stage2.id.slice(0, 8)}).`,
      detail: { itemId: draft.id, slug: input.slug, stage2ApprovalId: stage2.id, productionUrl: prodUrl, qualityNote: reviewNote },
    }
  } catch (err) {
    return { ok: false, summary: `approve_blog_pitch (webflow) failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── webflow_update_blog_meta ────────────────────────────────────────────────

export interface WfUpdateBlogMetaInput { slug: string; newTitle?: string; newDescription?: string }

export async function execWebflowUpdateBlogMeta(
  input: WfUpdateBlogMetaInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || (!input.newTitle && !input.newDescription)) {
    return { ok: false, summary: 'webflow_update_blog_meta error: slug plus newTitle and/or newDescription required', error: 'missing fields' }
  }
  try {
    const map  = await wf.resolveBlogFields(ctx.tenant)
    const item = await wf.getItemBySlug(ctx.tenant, input.slug)
    if (!item) return { ok: false, summary: `webflow_update_blog_meta: no blog item with slug '${input.slug}'`, error: 'item_not_found' }

    const fieldData: Record<string, unknown> = {}
    if (input.newTitle) fieldData[map.titleField] = input.newTitle
    if (input.newDescription) {
      if (!map.metaDescField) {
        return { ok: false, summary: 'webflow_update_blog_meta: no meta-description-like field on the blog collection — title-only updates possible', error: 'meta_field_unresolved' }
      }
      fieldData[map.metaDescField] = input.newDescription
    }

    await wf.updateItemFields(ctx.tenant, item.id, fieldData)
    await wf.publishItems(ctx.tenant, [item.id])

    const check = await verifyItemFields(ctx, item.id, fieldData)
    if (!check.ok) return silentFailure('webflow_update_blog_meta', check.mismatches)

    return {
      ok: true,
      summary: `Updated blog meta on '${input.slug}' and republished (verified).`,
      detail: { itemId: item.id, ...fieldData },
    }
  } catch (err) {
    return { ok: false, summary: `webflow_update_blog_meta failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── webflow_update_blog_body ────────────────────────────────────────────────

export interface WfUpdateBlogBodyInput { slug: string; newContent: string }

export async function execWebflowUpdateBlogBody(
  input: WfUpdateBlogBodyInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || !input.newContent) {
    return { ok: false, summary: 'webflow_update_blog_body error: slug and newContent required', error: 'missing fields' }
  }
  try {
    const map  = await wf.resolveBlogFields(ctx.tenant)
    if (!map.bodyField) return { ok: false, summary: 'webflow_update_blog_body: no RichText body field resolved', error: 'body_field_unresolved' }
    const item = await wf.getItemBySlug(ctx.tenant, input.slug)
    if (!item) return { ok: false, summary: `webflow_update_blog_body: no blog item with slug '${input.slug}'`, error: 'item_not_found' }

    await wf.updateItemFields(ctx.tenant, item.id, { [map.bodyField]: input.newContent })
    await wf.publishItems(ctx.tenant, [item.id])

    // Rich text may be normalized by Webflow — verify presence, not equality:
    // the re-read body must be non-empty and materially the new content
    // (first 60 chars of visible text match).
    const after = await wf.getItemById(ctx.tenant, item.id)
    const gotBody = String(after.fieldData[map.bodyField] ?? '')
    const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!gotBody || strip(gotBody) !== strip(input.newContent)) {
      return silentFailure('webflow_update_blog_body', [`${map.bodyField}: body did not persist as written`])
    }

    return { ok: true, summary: `Replaced body of '${input.slug}' and republished (verified).`, detail: { itemId: item.id } }
  } catch (err) {
    return { ok: false, summary: `webflow_update_blog_body failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── webflow_add_blog_alt_text ───────────────────────────────────────────────

export interface WfAddBlogAltTextInput { slug: string; newAltText: string }

export async function execWebflowAddBlogAltText(
  input: WfAddBlogAltTextInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || !input.newAltText) {
    return { ok: false, summary: 'webflow_add_blog_alt_text error: slug and newAltText required', error: 'missing fields' }
  }
  try {
    const map  = await wf.resolveBlogFields(ctx.tenant)
    if (!map.imageField) return { ok: false, summary: 'webflow_add_blog_alt_text: no Image field resolved on the blog collection', error: 'image_field_unresolved' }
    const item = await wf.getItemBySlug(ctx.tenant, input.slug)
    if (!item) return { ok: false, summary: `webflow_add_blog_alt_text: no blog item with slug '${input.slug}'`, error: 'item_not_found' }

    const existing = (item.fieldData[map.imageField] ?? {}) as Record<string, unknown>
    if (!existing.url) return { ok: false, summary: `webflow_add_blog_alt_text: '${input.slug}' has no image set — nothing to alt-text`, error: 'no_image' }

    const wanted = { url: existing.url, alt: input.newAltText }
    await wf.updateItemFields(ctx.tenant, item.id, { [map.imageField]: wanted })
    await wf.publishItems(ctx.tenant, [item.id])

    // THE footgun case: alt-only PATCHes have been observed to 200-and-drop.
    const check = await verifyItemFields(ctx, item.id, { [map.imageField]: wanted })
    if (!check.ok) return silentFailure('webflow_add_blog_alt_text', check.mismatches)

    return { ok: true, summary: `Set image alt text on '${input.slug}' and republished (verified persisted).`, detail: { itemId: item.id, alt: input.newAltText } }
  } catch (err) {
    return { ok: false, summary: `webflow_add_blog_alt_text failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── webflow_add_internal_link ───────────────────────────────────────────────

export interface WfAddInternalLinkInput { slug: string; sourceText: string; targetUrl: string }

export async function execWebflowAddInternalLink(
  input: WfAddInternalLinkInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || !input.sourceText || !input.targetUrl) {
    return { ok: false, summary: 'webflow_add_internal_link error: slug, sourceText, targetUrl all required', error: 'missing fields' }
  }
  try {
    const map  = await wf.resolveBlogFields(ctx.tenant)
    if (!map.bodyField) return { ok: false, summary: 'webflow_add_internal_link: no RichText body field resolved', error: 'body_field_unresolved' }
    const item = await wf.getItemBySlug(ctx.tenant, input.slug)
    if (!item) return { ok: false, summary: `webflow_add_internal_link: no blog item with slug '${input.slug}'`, error: 'item_not_found' }

    const body = String(item.fieldData[map.bodyField] ?? '')
    const idx = body.indexOf(input.sourceText)
    if (idx === -1) {
      return { ok: false, summary: `webflow_add_internal_link: sourceText not found verbatim in '${input.slug}' body — re-read the page and use exact text`, error: 'source_text_not_found' }
    }
    // Don't double-link: reject if the occurrence is already inside an anchor.
    const before = body.slice(Math.max(0, idx - 200), idx)
    if (/<a\s[^>]*$/i.test(before)) {
      return { ok: false, summary: `webflow_add_internal_link: '${input.sourceText}' is already inside a link on '${input.slug}'`, error: 'already_linked' }
    }

    const anchor = `<a href="${input.targetUrl}">${input.sourceText}</a>`
    const newBody = body.slice(0, idx) + anchor + body.slice(idx + input.sourceText.length)

    await wf.updateItemFields(ctx.tenant, item.id, { [map.bodyField]: newBody })
    await wf.publishItems(ctx.tenant, [item.id])

    const after = await wf.getItemById(ctx.tenant, item.id)
    const gotBody = String(after.fieldData[map.bodyField] ?? '')
    if (!gotBody.includes(`href="${input.targetUrl}"`)) {
      return silentFailure('webflow_add_internal_link', [`${map.bodyField}: link to ${input.targetUrl} did not persist`])
    }

    return { ok: true, summary: `Linked '${input.sourceText}' → ${input.targetUrl} on '${input.slug}' and republished (verified).`, detail: { itemId: item.id } }
  } catch (err) {
    return { ok: false, summary: `webflow_add_internal_link failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── webflow_update_page_meta (static pages — API-writable on Webflow!) ─────

export interface WfUpdatePageMetaInput { pagePath: string; newTitle?: string; newDescription?: string }

export async function execWebflowUpdatePageMeta(
  input: WfUpdatePageMetaInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.pagePath || (!input.newTitle && !input.newDescription)) {
    return { ok: false, summary: 'webflow_update_page_meta error: pagePath plus newTitle and/or newDescription required', error: 'missing fields' }
  }
  try {
    const page = await wf.findPageByPath(ctx.tenant, input.pagePath)
    if (!page) return { ok: false, summary: `webflow_update_page_meta: no static page at '${input.pagePath}'`, error: 'page_not_found' }

    const seo: { title?: string; description?: string } = {}
    if (input.newTitle) seo.title = input.newTitle
    if (input.newDescription) seo.description = input.newDescription
    await wf.updatePageSeo(ctx.tenant, page.id, seo)
    await wf.publishSite(ctx.tenant)

    const meta = await wf.getPageMetadata(ctx.tenant, page.id)
    const gotSeo = (meta.seo ?? {}) as Record<string, unknown>
    const mismatches: string[] = []
    if (seo.title && String(gotSeo.title ?? '') !== seo.title) mismatches.push('seo.title did not persist')
    if (seo.description && String(gotSeo.description ?? '') !== seo.description) mismatches.push('seo.description did not persist')
    if (mismatches.length > 0) return silentFailure('webflow_update_page_meta', mismatches)

    return { ok: true, summary: `Updated SEO meta on ${page.path} and republished the site (verified).`, detail: { pageId: page.id, ...seo } }
  } catch (err) {
    return { ok: false, summary: `webflow_update_page_meta failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}

// ── webflow_update_marketing_page_text ──────────────────────────────────────

export interface WfUpdateMarketingPageTextInput { pagePath: string; oldText: string; newText: string }

export async function execWebflowUpdateMarketingPageText(
  input: WfUpdateMarketingPageTextInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.pagePath || !input.oldText || !input.newText) {
    return { ok: false, summary: 'webflow_update_marketing_page_text error: pagePath, oldText, newText all required', error: 'missing fields' }
  }
  try {
    const page = await wf.findPageByPath(ctx.tenant, input.pagePath)
    if (!page) return { ok: false, summary: `webflow_update_marketing_page_text: no static page at '${input.pagePath}'`, error: 'page_not_found' }

    const dom = await wf.getPageDom(ctx.tenant, page.id)
    const nodes = (dom.nodes ?? []) as Array<Record<string, unknown>>
    const textOf = (n: Record<string, unknown>): string => {
      const t = n.text
      if (typeof t === 'string') return t
      if (t && typeof t === 'object') {
        const tt = t as Record<string, unknown>
        return String(tt.html ?? tt.text ?? '')
      }
      return ''
    }
    const target = nodes.find(n => String(n.type ?? '') === 'text' && textOf(n).includes(input.oldText))
    if (!target) {
      return { ok: false, summary: `webflow_update_marketing_page_text: oldText not found on '${page.path}' — re-read the page and use exact text`, error: 'old_text_not_found' }
    }

    const updated = textOf(target).replace(input.oldText, input.newText)
    await wf.updatePageDomNodes(ctx.tenant, page.id, [{ nodeId: String(target.id), text: updated }])
    await wf.publishSite(ctx.tenant)

    const domAfter = await wf.getPageDom(ctx.tenant, page.id)
    const nodesAfter = (domAfter.nodes ?? []) as Array<Record<string, unknown>>
    const persisted = nodesAfter.some(n => textOf(n).includes(input.newText))
    if (!persisted) return silentFailure('webflow_update_marketing_page_text', ['DOM text update did not persist'])

    return { ok: true, summary: `Updated text on ${page.path} and republished the site (verified).`, detail: { pageId: page.id, nodeId: String(target.id) } }
  } catch (err) {
    return { ok: false, summary: `webflow_update_marketing_page_text failed: ${String(err).slice(0, 160)}`, error: String(err).slice(0, 400) }
  }
}
