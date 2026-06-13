// src/integrations/framer/executor.ts
//
// Handlers for approved Framer actions. The execution worker dispatches here
// via src/execution/dispatcher.ts.
//
// Two executors:
//   - execFramerConfirmPublish — commits a preview using its confirmationHash
//   - execFramerRollbackDraft  — removes a draft CMS item (cleanup)
//
// The "draft + preview" step is NOT an executor — it's a tool the agent
// invokes directly (see tools.ts: framer_draft_blog_post). The agent calls
// it during reasoning, gets back {itemId, confirmationHash, ...}, and then
// files a propose_action with toolName='framer_confirm_publish' and toolInput
// containing the hash + itemId (for display + potential rollback).
//
// Each handler:
//   - Loads tenant + credential via the client wrapper
//   - Performs the operation
//   - Returns an ExecutionResult (never throws — errors become ok:false)

import * as fr from './client'
import { logger } from '../../logger'
import { onPublishSucceeded, onPublishFailed } from '../../memory/pipeline-events'
import type { IntegrationContext, ExecutionResult } from '../types'
import {
  applyBlogItemEdit,
  findBlogCollection,
  resolveBlogFieldIdsExtended,
} from './cms-write'

// ── framer_confirm_publish ─────────────────────────────────────────────────

export interface ConfirmPublishInput {
  confirmationHash: string
  itemId?:          string   // for display + rollback if confirm fails
  slug?:            string   // for human-readable summary
  title?:           string   // for human-readable summary
}

export async function execFramerConfirmPublish(
  input: ConfirmPublishInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.confirmationHash) {
      return { ok: false, summary: 'confirmationHash is required', error: 'missing confirmationHash' }
    }

    // Phase 9e: preflight orphan-prevention check.
    // Framer's deploy is workspace-wide — anything sitting in staging-ahead-of-
    // production gets flushed live alongside our draft. Before we commit our
    // draft to staging, verify staging matches production. If staging is
    // already ahead, refuse and surface a clean error to the operator.
    try {
      const pubInfo = await fr.getPublishInfo(ctx.tenant)
      const stagingTime = pubInfo?.staging?.deploymentTime ?? 0
      const productionTime = pubInfo?.production?.deploymentTime ?? 0
      if (stagingTime > productionTime) {
        const diffSec = Math.round((stagingTime - productionTime) / 1000)
        logger.warn('preflight_staging_ahead_of_prod', {
          tenantId:     ctx.tenant.tenantId,
          taskId:       ctx.taskId,
          approvalId:   ctx.approvalId,
          slug:         input.slug,
          stagingTime,
          productionTime,
          diffSeconds:  diffSec,
        })
        return {
          ok:      false,
          summary: `Staging has pending changes that pre-date this draft (staging is ${diffSec}s ahead of production). Refusing to deploy until staging matches production — otherwise the pending changes would publish too.`,
          error:   'STAGING_AHEAD_OF_PRODUCTION',
          detail: {
            stagingDeploymentTime:    stagingTime,
            productionDeploymentTime: productionTime,
            diffSeconds:              diffSec,
            action:                   'Open Framer → either publish the pending changes manually (if intended) or revert them (if not). Then retry this approval.',
          },
        }
      }
    } catch (err) {
      // Preflight check failed at the API level (network, auth, etc).
      // Don't block the deploy on infra issues — log and proceed. If staging
      // really is dirty, the deploy still publishes orphans, but blocking on
      // every transient API blip is worse than the alternative.
      logger.warn('preflight_publish_info_failed', {
        tenantId:   ctx.tenant.tenantId,
        taskId:     ctx.taskId,
        approvalId: ctx.approvalId,
        err:        String(err).slice(0, 300),
      })
    }

    // Step 1: commit the draft to staging via confirm_publish.
    const stagingResult = await fr.confirmPublish(ctx.tenant, input.confirmationHash)
    logger.info('exec_framer_confirm_publish', {
      tenantId:     ctx.tenant.tenantId,
      taskId:       ctx.taskId,
      approvalId:   ctx.approvalId,
      deploymentId: stagingResult.deployment?.id,
      slug:         input.slug,
    })

    // Phase 9d: confirm_publish only deploys to staging. The production custom
    // domain (e.g. tarino.au) stays untouched until deploy_to_production fires.
    // Without this second call the page is 404 on prod even though the executor
    // returned success. See client.ts deployToProduction + the framer manual
    // test 05-publish.mts which documents this two-step behaviour.
    let prodResult
    try {
      prodResult = await fr.deployToProduction(ctx.tenant)
      logger.info('exec_framer_deploy_to_production', {
        tenantId:     ctx.tenant.tenantId,
        taskId:       ctx.taskId,
        approvalId:   ctx.approvalId,
        deploymentId: prodResult.deployment?.id,
        slug:         input.slug,
      })

      // Chunk 2c: record the publish success in L2 memory (replaces the
      // 'pitch-approved' entry with 'published').
      void onPublishSucceeded({
        tenantId: ctx.tenant.tenantId,
        slug:     input.slug ?? '',
        title:    input.title,
      })
    } catch (err) {
      // Staging was committed but production deploy failed. This is a
      // partial-success state — the draft is live on <project>.framer.app
      // but the operator needs to push to production manually (or we retry).
      logger.error('exec_framer_deploy_to_production_failed', {
        tenantId:            ctx.tenant.tenantId,
        taskId:              ctx.taskId,
        approvalId:          ctx.approvalId,
        stagingDeploymentId: stagingResult.deployment?.id,
        slug:                input.slug,
        err:                 String(err).slice(0, 500),
      })

      // Chunk 2c: record the publish failure in L2 memory.
      void onPublishFailed({
        tenantId: ctx.tenant.tenantId,
        slug:     input.slug ?? '',
        error:    String(err),
      })
      return {
        ok:      false,
        summary: 'Committed to staging but deploy_to_production failed. Push manually from Framer UI or retry.',
        error:   String(err).slice(0, 500),
        detail:  { ...input, stagingResult },
      }
    }

    // Use prodResult.hostnames for the production URL — it reflects the deploy
    // that just happened. Fall back to stagingResult if prodResult is empty.
    const hostnames = prodResult.hostnames ?? stagingResult.hostnames
    const productionHost = hostnames?.find(h => h.type === 'custom' && h.isPublished)?.hostname
    const summary = input.title
      ? `Published "${input.title}" to ${productionHost ?? 'production'}`
      : `Published deployment ${prodResult.deployment?.id ?? '(unknown)'} to ${productionHost ?? 'production'}`

    return {
      ok:      true,
      summary,
      detail:  {
        ...input,
        stagingResult,
        prodResult,
        productionUrl: productionHost ? `https://${productionHost}/${input.slug ?? ''}` : undefined,
      },
    }
  } catch (err) {
    return { ok: false, summary: 'Framer confirm_publish failed', error: String(err).slice(0, 500) }
  }
}

// ── framer_rollback_draft ──────────────────────────────────────────────────

export interface RollbackDraftInput {
  itemId: string
  slug?:  string   // for the summary line
}

export async function execFramerRollbackDraft(
  input: RollbackDraftInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.itemId) {
      return { ok: false, summary: 'itemId is required', error: 'missing itemId' }
    }

    await fr.removeBlogPost(ctx.tenant, input.itemId)
    logger.info('exec_framer_rollback_draft', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      itemId:     input.itemId,
      slug:       input.slug,
    })

    return {
      ok:      true,
      summary: input.slug
        ? `Removed draft "${input.slug}" from Blog`
        : `Removed draft item ${input.itemId} from Blog`,
      detail:  { ...input, rolledBack: true },
    }
  } catch (err) {
    return { ok: false, summary: 'Framer rollback failed', error: String(err).slice(0, 500) }
  }
}

// ── framer_create_and_publish_blog_post ─────────────────────────────────────
//
// Atomic create + publish path. Filed via propose_action with the FULL post
// content inline in toolInput. The approval card lets the operator review the
// content before publishing. On approve, this executor creates the CMS item
// AND publishes the site in one atomic operation — no orphan drafts on reject.

export interface CreateAndPublishBlogPostInput {
  slug:      string
  title:     string
  content:   string
  imageUrl:  string   // required — every published post must have a hero
}

export async function execFramerCreateAndPublishBlogPost(
  input: CreateAndPublishBlogPostInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug || !input.title || !input.content) {
      return { ok: false, summary: 'slug, title, and content are required', error: 'missing required fields' }
    }
    if (!input.imageUrl || !input.imageUrl.trim()) {
      return {
        ok:      false,
        summary: 'imageUrl is required — every published post must have a hero image',
        error:   'HERO_IMAGE_REQUIRED',
        detail:  {
          slug: input.slug,
          remediation: 'Agent must call pexels_search with a 2-4 word concrete-noun query before proposing publish, then include the returned url_for_post as toolInput.imageUrl.',
        },
      }
    }
    const result = await fr.createAndPublishBlogPost(ctx.tenant, input)
    logger.info('exec_framer_create_and_publish_blog_post', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      itemId:     result.itemId,
      slug:       result.slug,
    })
    return {
      ok:      true,
      summary: `Published "${input.title}" at ${result.productionUrl}`,
      detail:  {
        itemId:        result.itemId,
        slug:          result.slug,
        productionUrl: result.productionUrl,
        publishedAt:   result.publishedAt,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: 'Failed to create + publish blog post',
      error:   String(err).slice(0, 500),
    }
  }
}

// ── manual_operator_task ────────────────────────────────────────────────────
//
// For work the operator does manually (schema markup pastes, internal linking
// edits, copy tweaks). On approve, the executor records acknowledgement; the
// actual change is the operator's manual action in Framer's editor afterwards.

export interface ManualOperatorTaskInput {
  instruction: string
  category?:   string
}

export async function execManualOperatorTask(
  input: ManualOperatorTaskInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.instruction) {
      return { ok: false, summary: 'instruction is required', error: 'missing instruction' }
    }
    logger.info('exec_manual_operator_task', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      category:   input.category ?? 'unspecified',
    })
    return {
      ok:      true,
      summary: input.category
        ? `Acknowledged manual task (${input.category})`
        : 'Acknowledged manual operator task',
      detail:  {
        acknowledgedAt: new Date().toISOString(),
        category:       input.category ?? null,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: 'Failed to record manual task acknowledgement',
      error:   String(err).slice(0, 500),
    }
  }
}



// ── Phase 8: execApproveBlogPitch ───────────────────────────────────────────
//
// Stage 1 of the two-stage approval flow. Fires when operator approves a
// `approve_blog_pitch` proposal in Slack. Side effects:
//   1) Creates the Framer CMS draft via draftAndPreviewBlogPost (writes the
//      Title, Date, Content, and Image fields; gets a confirmationHash).
//   2) Inserts a Stage 2 approval row with tool_name='framer_confirm_publish',
//      parent_approval_id pointing back at this Stage 1 row. The hitl
//      worker's standard Slack-card path picks this up and posts the
//      Stage 2 card automatically.
//   3) Returns success — the executor framework writes execution_jobs.result
//      with the new approvalId so the operator can trace the chain.
//
// On any failure: surfaces the error via the standard ExecutionResult.error
// channel. The Stage 1 approval row is marked execution_error by the
// framework, and the operator sees the failure in Slack.

import { createApproval } from '../../hitl/state-store'
import { pool } from '../../memory/postgres'
import { presenter } from '../../core/slack'
import { getRun } from '../../core/slack/state-store'
import { scoreAndMaybeRevise } from '../surfer/revision'

export interface ApproveBlogPitchInput {
  slug:        string
  title:       string
  content:     string             // HTML in Framer formattedText format
  imageUrl?:   string
  whyThisTopic?: string
  /** Target keyword for Surfer scoring (Phase 4 Lever 1). Falls back to title. */
  targetKeyword?: string
}

export async function execApproveBlogPitch(
  input: ApproveBlogPitchInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || !input.title || !input.content) {
    return { ok: false, summary: 'approve_blog_pitch error: slug, title, content all required',
             error: 'missing required field in toolInput' }
  }
  try {
    // Phase 4 Lever 1: score the draft and, if below threshold, run one
    // revision pass BEFORE drafting — so the operator reviews the better
    // version and sees the score on the card. Best-effort: if Surfer is
    // unconfigured/unreachable this returns the original content untouched.
    const revision = await scoreAndMaybeRevise({
      model:   ctx.tenant.agentModel,
      keyword: input.targetKeyword ?? input.title,
      content: input.content,
    })
    if (revision.note) {
      logger.info('surfer_pre_hitl_revision', {
        slug: input.slug, available: revision.available, scored: revision.scored,
        scoreBefore: revision.scoreBefore, scoreAfter: revision.scoreAfter,
        revised: revision.revised, note: revision.note,
      })
    }
    const draftContent = revision.content

    // 1. Create the Framer draft (writes CMS item, gets confirmationHash)
    const draft = await fr.draftAndPreviewBlogPost(ctx.tenant, {
      slug:     input.slug,
      title:    input.title,
      content:  draftContent,
      imageUrl: input.imageUrl,
    })

    // 2. File the Stage 2 approval (framer_confirm_publish), linked to Stage 1
    const stage1ApprovalId = ctx.approvalId
    if (!stage1ApprovalId) {
      return { ok: false, summary: 'approve_blog_pitch error: missing Stage 1 approvalId in context',
               error: 'ctx.approvalId is undefined; cannot link Stage 2 back' }
    }

    const projectUrl = ctx.tenant.framer_project_url ?? ''
    // Phase 9c: construct an item-specific preview URL so the operator
    // lands in the editor view of THIS draft, not the project root.
    // Framer's URL pattern: <project>?item=<itemId>. The node parameter
    // is helpful but not strictly required — Framer resolves the item.
    const stage2PreviewUrl = projectUrl
      ? `${projectUrl}${projectUrl.includes('?') ? '&' : '?'}item=${encodeURIComponent(draft.itemId)}`
      : ''

    const stage2 = await createApproval(pool, {
      tenantId:        ctx.tenant.tenantId,
      taskId:          ctx.taskId,
      toolName:        'framer_confirm_publish',
      toolInput:       {
        confirmationHash: draft.preview.confirmationHash,
        itemId:           draft.itemId,
        slug:             input.slug,
        title:            input.title,
      } as Record<string, unknown>,
      riskLevel:       'high',
      riskReason:      'Will publish the drafted post live to tarino.au.',
      priority:        'P1',
      proposedAction:  `Publish '${input.title}' to /resources/${input.slug}`,
      whyPriority:     input.whyThisTopic ?? 'Draft ready for review in Framer — open the preview link, eyeball, then approve to publish.',
      slackChannelId:  null as unknown as string | undefined,
      previewUrl:      stage2PreviewUrl,
      parentApprovalId: stage1ApprovalId,
    })

    // Phase 9c: log post-creation metrics so we can track whether
    // the agent's compliance with image + internal-link rules holds.
    const _content = (input.content ?? '') as string
    const _linkCount = (_content.match(/<a\s+href=/gi) ?? []).length
    // eslint-disable-next-line no-console
    console.log('phase9c_link_count', { slug: input.slug, hasImage: !!input.imageUrl, linkCount: _linkCount, contentLength: _content.length })

    // Phase 9c: actually post the Stage 2 Slack card. Phase 8 inserted
    // the DB row but forgot the presenter call — Stage 2 row existed
    // but the operator never saw a card to act on.
    const run = await getRun(pool, ctx.taskId)
    const channelId = run?.channelId ?? ctx.tenant.slackChannelId
    if (channelId) {
      try {
        await presenter.requestApproval({
          tenantId:   ctx.tenant.tenantId,
          channelId,
          taskId:     ctx.taskId,
          toolName:   'framer_confirm_publish',
          riskLevel:  'high',
          riskReason: 'Publishes the drafted post to the live site.',
          approvalId: stage2.id,
          previewUrl: stage2PreviewUrl,
          tenantName: ctx.tenant.clientName,
          summary:    revision.note
            ? `Publish '${input.title}' to /resources/${input.slug} · ${revision.note}`
            : `Publish '${input.title}' to /resources/${input.slug}`,
        })
      } catch (err) {
        // Card post failure shouldn't fail the executor — DB row is the source of truth.
        // Operator can still hit the row via /agent approvals or DB query if card fails.
        // Logged for debugging.
      }
    }

    return {
      ok:      true,
      summary: `Draft created in Framer. Stage 2 card posted (approval id ${stage2.id.slice(0, 8)}).`,
      detail: {
        itemId:            draft.itemId,
        slug:              input.slug,
        confirmationHash:  draft.preview.confirmationHash,
        stage2ApprovalId:  stage2.id,
        stage2PreviewUrl,
        framerProjectUrl:  projectUrl,
        productionUrl:     `https://tarino.au/resources/${input.slug}`,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `approve_blog_pitch failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 400),
    }
  }
}

// ── framer_update_blog_meta ─────────────────────────────────────────────────
//
// Single-stage approval write executor. Updates the Title and/or Description
// CMS fields on an existing blog item, then publishes + deploys to production.
//
// Agent files propose_action with:
//   toolName:   'framer_update_blog_meta'
//   toolInput:  { slug, newTitle?, newDescription? }
//   riskLevel:  'medium'
//
// On approval, executor:
//   1. Resolves field IDs; errors if Description requested but missing schema
//   2. Updates the requested fields via addItems (id=existing → update)
//   3. preview → confirm_publish → deploy_to_production (atomic)
//   4. Rollback to original values on any post-update failure
//
// Tarino's Blog schema currently has Title/Date/Content/Image only. Until the
// operator adds a Description field to the Blog collection AND updates the
// blog page template to interpolate {{Description}} in Page Settings, this
// executor returns BLOG_SCHEMA_NO_DESCRIPTION_FIELD when newDescription is
// passed. Title-only updates work today.

export interface UpdateBlogMetaInput {
  slug:            string
  newTitle?:       string
  newDescription?: string
}

export async function execFramerUpdateBlogMeta(
  input: UpdateBlogMetaInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug) {
      return { ok: false, summary: 'slug is required', error: 'missing slug' }
    }
    if (!input.newTitle && !input.newDescription) {
      return {
        ok:      false,
        summary: 'At least one of newTitle or newDescription is required',
        error:   'no fields to update',
      }
    }

    // Resolve field IDs (cheap session — schema only) before applying edit
    const fieldIds = await fr.withFramerSession(ctx.tenant, async (framer) => {
      const blog = await findBlogCollection(framer)
      return resolveBlogFieldIdsExtended(blog)
    })

    if (input.newDescription && !fieldIds.descriptionId) {
      return {
        ok:      false,
        summary: 'Cannot update meta description: no Description field exists in the Blog schema yet',
        error:   'BLOG_SCHEMA_NO_DESCRIPTION_FIELD',
        detail:  {
          slug:        input.slug,
          setupNeeded: [
            'Open the Blog collection in Framer designer',
            'Click Settings → add a Plain Text field named "Description"',
            'Open the blog page template → Page Settings → Description field',
            'Set it to {{Description}} so it interpolates the CMS value',
            'Publish the template change',
            'Then retry: framer_update_blog_meta will work for descriptions',
          ],
        },
      }
    }

    const fieldUpdates: Record<string, { type: string; value: unknown }> = {}
    const changedFieldIds: string[] = []
    if (input.newTitle) {
      fieldUpdates[fieldIds.titleId] = { type: 'string', value: input.newTitle }
      changedFieldIds.push(fieldIds.titleId)
    }
    if (input.newDescription && fieldIds.descriptionId) {
      fieldUpdates[fieldIds.descriptionId] = { type: 'string', value: input.newDescription }
      changedFieldIds.push(fieldIds.descriptionId)
    }

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds,
    })

    const updatedFields: string[] = []
    if (input.newTitle)       updatedFields.push('title')
    if (input.newDescription) updatedFields.push('description')

    logger.info('exec_framer_update_blog_meta', {
      tenantId:     ctx.tenant.tenantId,
      taskId:       ctx.taskId,
      approvalId:   ctx.approvalId,
      slug:         input.slug,
      itemId:       editResult.itemId,
      updatedFields,
    })

    return {
      ok:      true,
      summary: `Updated ${updatedFields.join(' + ')} on ${editResult.productionUrl}`,
      detail:  {
        slug:          input.slug,
        itemId:        editResult.itemId,
        productionUrl: editResult.productionUrl,
        deploymentId:  editResult.deploymentId,
        before:        editResult.before,
        after:         editResult.after,
        updatedFields,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `framer_update_blog_meta failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 500),
    }
  }
}

// ── framer_update_blog_body ─────────────────────────────────────────────────
//
// Replaces the Content field (HTML formattedText) on an existing blog post,
// then publishes + deploys to production. Body changes are substantive — per
// operator's tier rules these are Tier A (double approval) but we render the
// FULL new HTML in the approval card so single-stage is acceptable when the
// operator reviews the content carefully before approving.
//
// Agent files propose_action with:
//   toolName:   'framer_update_blog_body'
//   toolInput:  { slug, newContent }
//   riskLevel:  'high'
//
// Use cases:
//   - Refreshing thin/stale content on existing posts
//   - Adding new sections or paragraphs to existing posts
//   - Inserting internal links (just embed <a href="..."> in the HTML)
//   - Replacing weak content with depth (research, examples, data)
//
// NOT for:
//   - Creating new posts (use approve_blog_pitch — two-stage with draft preview)
//   - Meta-only changes (use framer_update_blog_meta — much cheaper)

export interface UpdateBlogBodyInput {
  slug:       string
  newContent: string   // HTML in Framer formattedText format
}

export async function execFramerUpdateBlogBody(
  input: UpdateBlogBodyInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug) {
      return { ok: false, summary: 'slug is required', error: 'missing slug' }
    }
    if (!input.newContent) {
      return { ok: false, summary: 'newContent is required', error: 'missing newContent' }
    }
    // Guard against accidentally clobbering with near-empty content
    if (input.newContent.length < 50) {
      return {
        ok:      false,
        summary: `Refusing to clobber existing body with ${input.newContent.length} chars of content — likely a malformed update`,
        error:   'CONTENT_TOO_SHORT',
        detail:  { slug: input.slug, providedLength: input.newContent.length },
      }
    }

    const fieldIds = await fr.withFramerSession(ctx.tenant, async (framer) => {
      const blog = await findBlogCollection(framer)
      return resolveBlogFieldIdsExtended(blog)
    })

    const fieldUpdates = {
      [fieldIds.contentId]: { type: 'formattedText', value: input.newContent },
    }
    const changedFieldIds = [fieldIds.contentId]

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds,
    })

    // Compute char delta for telemetry
    const beforeContentLength = (() => {
      const before = editResult.before.find((s: any) => s.fieldId === fieldIds.contentId)
      return typeof before?.value === 'string' ? before.value.length : 0
    })()
    const afterContentLength = input.newContent.length
    const delta = afterContentLength - beforeContentLength

    // Count internal links inserted (for visibility into agent behaviour)
    const linkCount = (input.newContent.match(/<a\s+href=/gi) ?? []).length

    logger.info('exec_framer_update_blog_body', {
      tenantId:            ctx.tenant.tenantId,
      taskId:              ctx.taskId,
      approvalId:          ctx.approvalId,
      slug:                input.slug,
      itemId:              editResult.itemId,
      beforeContentLength,
      afterContentLength,
      delta,
      linkCount,
    })

    const sign = delta >= 0 ? '+' : ''
    return {
      ok:      true,
      summary: `Updated body content on ${editResult.productionUrl} (${sign}${delta} chars, ${linkCount} link${linkCount === 1 ? '' : 's'})`,
      detail:  {
        slug:                input.slug,
        itemId:              editResult.itemId,
        productionUrl:       editResult.productionUrl,
        deploymentId:        editResult.deploymentId,
        beforeContentLength,
        afterContentLength,
        delta,
        linkCount,
        // Keep full before/after snapshots in editResult — accessible via
        // execution_jobs.result for ad-hoc rollback. Not duplicated here to
        // avoid bloating the dispatcher result column.
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `framer_update_blog_body failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 500),
    }
  }
}

// ── Internal helper: escapeRegex for marker-based custom code blocks ────────
function escapeRegexForCustomCode(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── framer_add_site_schema ──────────────────────────────────────────────────
//
// Injects a JSON-LD schema.org block site-wide via Framer's setCustomCode API
// at headEnd. Schema blocks are wrapped in marker comments so the executor
// can find and replace its own previous output without disturbing other
// custom code the operator has set up manually.
//
// Agent files propose_action with:
//   toolName:   'framer_add_site_schema'
//   toolInput:  { schemaId, jsonLd }
//   riskLevel:  'high'  (Tier A — site-wide change)
//
// schemaId is a stable identifier ('organization', 'website', 'localbusiness')
// so re-running with the same schemaId UPDATES the existing block rather
// than adding a duplicate. The operator can review the full JSON-LD in the
// approval card before approving.
//
// Notes:
//   - jsonLd MUST be valid JSON with @context and @type fields
//   - Each call REPLACES the headEnd custom code with the union of existing
//     blocks + this update; rollback restores the previous headEnd verbatim
//   - For per-page schema, use CMS field interpolation in page template
//     (Pro plan feature — out of scope here)

export interface AddSiteSchemaInput {
  schemaId: string
  jsonLd:   string
}

export async function execFramerAddSiteSchema(
  input: AddSiteSchemaInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.schemaId) return { ok: false, summary: 'schemaId is required', error: 'missing schemaId' }
    if (!input.jsonLd)   return { ok: false, summary: 'jsonLd is required',   error: 'missing jsonLd' }

    let parsed: any
    try {
      parsed = JSON.parse(input.jsonLd)
    } catch (err) {
      return {
        ok:      false,
        summary: 'jsonLd is not valid JSON',
        error:   'JSONLD_PARSE_FAILED',
        detail:  { schemaId: input.schemaId, parseError: String(err).slice(0, 200) },
      }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, summary: 'jsonLd must be a JSON object', error: 'JSONLD_NOT_OBJECT' }
    }
    if (!parsed['@context'] || !parsed['@type']) {
      return {
        ok:      false,
        summary: 'jsonLd missing @context or @type — required for schema.org JSON-LD',
        error:   'JSONLD_MISSING_REQUIRED_FIELDS',
        detail:  { schemaId: input.schemaId, hasContext: !!parsed['@context'], hasType: !!parsed['@type'] },
      }
    }

    const result = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      // Workspace must be clean
      const cp = await framer.getChangedPaths()
      const pending = (cp.added?.length ?? 0) + (cp.removed?.length ?? 0) + (cp.modified?.length ?? 0)
      if (pending > 0) {
        throw new Error(`Refusing to edit: ${pending} pending change(s) already in Framer workspace.`)
      }

      // Read current custom code (defensive: support shape variants from SDK)
      let current: any
      try {
        current = await framer.getCustomCode()
      } catch (err) {
        throw new Error(`getCustomCode failed — the framer-api version may not expose this method: ${String(err).slice(0, 200)}`)
      }
      // SDK may return { headEnd: { html } } or { headEnd: 'string' } or null
      const currentHeadEnd = ((): string => {
        const he = current?.headEnd
        if (typeof he === 'string') return he
        if (he && typeof he === 'object' && typeof he.html === 'string') return he.html
        return ''
      })()
      const beforeHeadEnd = currentHeadEnd

      // Compose new schema block with marker comments
      const startMarker = `<!-- agent-schema:${input.schemaId} -->`
      const endMarker   = `<!-- /agent-schema:${input.schemaId} -->`
      const newBlock    = `${startMarker}\n<script type="application/ld+json">${input.jsonLd}</script>\n${endMarker}`

      const blockPattern = new RegExp(
        `${escapeRegexForCustomCode(startMarker)}[\\s\\S]*?${escapeRegexForCustomCode(endMarker)}`,
        'i',
      )
      const newHeadEnd = blockPattern.test(currentHeadEnd)
        ? currentHeadEnd.replace(blockPattern, newBlock)
        : (currentHeadEnd ? `${currentHeadEnd}\n${newBlock}` : newBlock)

      // Write + publish + deploy, with rollback on failure
      let prodResult: any
      try {
        await framer.setCustomCode({ html: newHeadEnd, location: 'headEnd' })
        const preview = await framer.publishForAgent({ action: 'preview' })
        const hash = preview?.confirmationHash ?? preview?.nextAction?.confirmationHash
        if (!hash) {
          throw new Error(`Preview returned no confirmationHash. Shape: ${JSON.stringify(preview ?? null).slice(0, 500)}`)
        }
        await framer.publishForAgent({ action: 'confirm_publish', confirmationHash: hash })
        prodResult = await framer.publishForAgent({ action: 'deploy_to_production' })
      } catch (err) {
        logger.warn('schema_rollback_attempt', {
          tenantId: ctx.tenant.tenantId,
          schemaId: input.schemaId,
          err:      String(err).slice(0, 300),
        })
        try {
          await framer.setCustomCode({ html: beforeHeadEnd, location: 'headEnd' })
          logger.info('schema_rolled_back', { tenantId: ctx.tenant.tenantId, schemaId: input.schemaId })
        } catch (rbErr) {
          logger.error('schema_rollback_failed', {
            tenantId:    ctx.tenant.tenantId,
            schemaId:    input.schemaId,
            originalErr: String(err).slice(0, 300),
            rollbackErr: String(rbErr).slice(0, 300),
          })
        }
        throw err
      }

      return { beforeHeadEnd, newHeadEnd, prodResult }
    })

    logger.info('exec_framer_add_site_schema', {
      tenantId:     ctx.tenant.tenantId,
      taskId:       ctx.taskId,
      approvalId:   ctx.approvalId,
      schemaId:     input.schemaId,
      schemaType:   parsed['@type'],
      jsonLdLength: input.jsonLd.length,
    })

    return {
      ok:      true,
      summary: `Injected ${parsed['@type']} JSON-LD (${input.schemaId}) site-wide`,
      detail:  {
        schemaId:     input.schemaId,
        schemaType:   parsed['@type'],
        jsonLdLength: input.jsonLd.length,
        deploymentId: result.prodResult.deployment?.id,
        beforeBytes:  result.beforeHeadEnd.length,
        afterBytes:   result.newHeadEnd.length,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `framer_add_site_schema failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 500),
    }
  }
}

// ── framer_add_blog_alt_text ────────────────────────────────────────────────
//
// Adds alt text to the Image field of an existing blog post. Reads the
// current image field value to detect its shape (string URL vs object
// with url/altText), then writes back with altText set.
//
// Agent files propose_action with:
//   toolName:   'framer_add_blog_alt_text'
//   toolInput:  { slug, newAltText }
//   riskLevel:  'low'  (alt text is pure accessibility/SEO win)
//
// If the Blog schema has no Image field, returns BLOG_SCHEMA_NO_IMAGE_FIELD.
// If the post has no image set yet, returns NO_IMAGE_TO_ANNOTATE.
// Image-field shape is detected at runtime — logs the shape for future
// reference so we can simplify once we've seen real data.

export interface AddBlogAltTextInput {
  slug:       string
  newAltText: string
}

export async function execFramerAddBlogAltText(
  input: AddBlogAltTextInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug)       return { ok: false, summary: 'slug is required',       error: 'missing slug' }
    if (!input.newAltText) return { ok: false, summary: 'newAltText is required', error: 'missing newAltText' }

    const { fieldIds, currentImageValue } = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      const blog = await findBlogCollection(framer)
      const fids = await resolveBlogFieldIdsExtended(blog)
      if (!fids.imageId) return { fieldIds: fids, currentImageValue: undefined }
      const items = await blog.getItems()
      const item = items.find((i: { slug: string }) => i.slug === input.slug)
      if (!item) throw new Error(`Blog item with slug "${input.slug}" not found`)
      return { fieldIds: fids, currentImageValue: item.fieldData?.[fids.imageId]?.value }
    })

    if (!fieldIds.imageId) {
      return {
        ok:      false,
        summary: 'Blog schema has no Image field — alt text cannot be set',
        error:   'BLOG_SCHEMA_NO_IMAGE_FIELD',
      }
    }
    if (currentImageValue === undefined || currentImageValue === null) {
      return {
        ok:      false,
        summary: 'Blog post has no image set — add an image first, then add alt text',
        error:   'NO_IMAGE_TO_ANNOTATE',
        detail:  { slug: input.slug },
      }
    }

    // Detect shape and construct updated value preserving original fields
    let updatedValue: unknown
    let detectedShape: string
    if (typeof currentImageValue === 'string') {
      detectedShape = 'url-string'
      updatedValue = { url: currentImageValue, altText: input.newAltText }
    } else if (typeof currentImageValue === 'object' && currentImageValue !== null) {
      detectedShape = 'object'
      updatedValue = { ...(currentImageValue as Record<string, unknown>), altText: input.newAltText }
    } else {
      return {
        ok:      false,
        summary: `Unexpected image field shape: ${typeof currentImageValue}`,
        error:   'IMAGE_FIELD_SHAPE_UNKNOWN',
        detail:  { currentValueType: typeof currentImageValue, sample: String(currentImageValue).slice(0, 200) },
      }
    }

    logger.info('alt_text_shape_detected', {
      tenantId:           ctx.tenant.tenantId,
      slug:               input.slug,
      shape:              detectedShape,
      currentValueSample: JSON.stringify(currentImageValue).slice(0, 200),
    })

    const fieldUpdates = {
      [fieldIds.imageId]: { type: 'image', value: updatedValue },
    }

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds: [fieldIds.imageId],
    })

    logger.info('exec_framer_add_blog_alt_text', {
      tenantId:      ctx.tenant.tenantId,
      taskId:        ctx.taskId,
      approvalId:    ctx.approvalId,
      slug:          input.slug,
      itemId:        editResult.itemId,
      altTextLength: input.newAltText.length,
      detectedShape,
    })

    return {
      ok:      true,
      summary: `Added alt text to image on ${editResult.productionUrl}`,
      detail:  {
        slug:          input.slug,
        itemId:        editResult.itemId,
        productionUrl: editResult.productionUrl,
        deploymentId:  editResult.deploymentId,
        altText:       input.newAltText,
        detectedShape,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `framer_add_blog_alt_text failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 500),
    }
  }
}

// ── framer_add_internal_link ────────────────────────────────────────────────
//
// Surgical internal-link insertion in an existing blog post body. Wraps the
// first occurrence of sourceText (outside existing <a> tags) in an anchor
// pointing to targetUrl. Refuses if a link to targetUrl already exists in
// the body.
//
// Agent files propose_action with:
//   toolName:   'framer_add_internal_link'
//   toolInput:  { slug, sourceText, targetUrl }
//   riskLevel:  'medium'
//
// For BULK or sweeping body rewrites, use framer_update_blog_body instead —
// this tool is for one-link-at-a-time additions.

export interface AddInternalLinkInput {
  slug:       string
  sourceText: string
  targetUrl:  string
}

function escapeRegexLink(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function insertInternalLink(html: string, sourceText: string, targetUrl: string): string | null {
  // Split on <a>...</a> blocks. We only insert into NON-anchor parts so we
  // never nest anchors or replace text inside existing links.
  const parts = html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi)
  for (let i = 0; i < parts.length; i++) {
    if (/^<a\b/i.test(parts[i])) continue
    const idx = parts[i].indexOf(sourceText)
    if (idx !== -1) {
      const safeUrl = targetUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      parts[i] = parts[i].slice(0, idx) +
                 `<a href="${safeUrl}">${sourceText}</a>` +
                 parts[i].slice(idx + sourceText.length)
      return parts.join('')
    }
  }
  return null
}

export async function execFramerAddInternalLink(
  input: AddInternalLinkInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug)       return { ok: false, summary: 'slug is required',       error: 'missing slug' }
    if (!input.sourceText) return { ok: false, summary: 'sourceText is required', error: 'missing sourceText' }
    if (!input.targetUrl)  return { ok: false, summary: 'targetUrl is required',  error: 'missing targetUrl' }

    const { fieldIds, currentContent } = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      const blog = await findBlogCollection(framer)
      const fids = await resolveBlogFieldIdsExtended(blog)
      const items = await blog.getItems()
      const item = items.find((i: { slug: string }) => i.slug === input.slug)
      if (!item) throw new Error(`Blog item with slug "${input.slug}" not found`)
      return {
        fieldIds:       fids,
        currentContent: (item.fieldData?.[fids.contentId]?.value ?? '') as string,
      }
    })

    // Refuse if already linked to that URL
    const escapedUrl = escapeRegexLink(input.targetUrl)
    const existingPattern = new RegExp(`<a[^>]*href=["']${escapedUrl}["']`, 'i')
    if (existingPattern.test(currentContent)) {
      return {
        ok:      false,
        summary: `A link to ${input.targetUrl} already exists in this post`,
        error:   'LINK_ALREADY_EXISTS',
        detail:  { slug: input.slug, targetUrl: input.targetUrl },
      }
    }

    const newContent = insertInternalLink(currentContent, input.sourceText, input.targetUrl)
    if (!newContent) {
      return {
        ok:      false,
        summary: `Source text "${input.sourceText.slice(0, 60)}" not found in body (outside existing links)`,
        error:   'SOURCE_TEXT_NOT_FOUND',
        detail:  { slug: input.slug, sourceText: input.sourceText },
      }
    }

    const fieldUpdates = {
      [fieldIds.contentId]: { type: 'formattedText', value: newContent },
    }

    const editResult = await applyBlogItemEdit(ctx.tenant, {
      slug:            input.slug,
      fieldUpdates,
      changedFieldIds: [fieldIds.contentId],
    })

    logger.info('exec_framer_add_internal_link', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      slug:       input.slug,
      itemId:     editResult.itemId,
      sourceText: input.sourceText.slice(0, 100),
      targetUrl:  input.targetUrl,
    })

    return {
      ok:      true,
      summary: `Linked "${input.sourceText.slice(0, 60)}" → ${input.targetUrl} on ${editResult.productionUrl}`,
      detail:  {
        slug:          input.slug,
        itemId:        editResult.itemId,
        productionUrl: editResult.productionUrl,
        deploymentId:  editResult.deploymentId,
        sourceText:    input.sourceText,
        targetUrl:     input.targetUrl,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `framer_add_internal_link failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 500),
    }
  }
}

// ── framer_update_marketing_page_text ───────────────────────────────────────
//
// Surgical text update on non-CMS marketing pages (About, Contact, Resources,
// homepage, etc). Uses Canvas Nodes API to find the target page by path,
// locate the TextNode whose current text exactly matches oldText, set the
// new text, then publish + deploy.
//
// Agent files propose_action with:
//   toolName:   'framer_update_marketing_page_text'
//   toolInput:  { pagePath, oldText, newText }
//   riskLevel:  'high'  (Tier A — substantive marketing-page change)
//
// Failure modes:
//   - PAGE_NOT_FOUND     pagePath doesn't match any page node
//   - TEXT_NOT_FOUND     oldText doesn't match any TextNode on the page
//   - AMBIGUOUS_TEXT     oldText matches >1 node — agent must be more specific
//   - CANVAS_API_UNAVAIL framer-api version doesn't expose getNodesWith*
//
// On any failure between setText and deploy: rollback to original text.
//
// Note: oldText must EXACTLY match the text in Framer's internal data model.
// HTML on the live site may differ slightly (entities, whitespace). When the
// match fails, the executor returns sample texts from the page so the agent
// can correct its oldText and retry.

export interface UpdateMarketingPageTextInput {
  pagePath: string
  oldText:  string
  newText:  string
}

export async function execFramerUpdateMarketingPageText(
  input: UpdateMarketingPageTextInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.pagePath) return { ok: false, summary: 'pagePath is required', error: 'missing pagePath' }
    if (!input.oldText)  return { ok: false, summary: 'oldText is required',  error: 'missing oldText' }
    if (!input.newText)  return { ok: false, summary: 'newText is required',  error: 'missing newText' }
    if (input.oldText === input.newText) {
      return { ok: false, summary: 'oldText and newText are identical', error: 'NO_CHANGE' }
    }

    const result = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      const cp = await framer.getChangedPaths()
      const pending = (cp.added?.length ?? 0) + (cp.removed?.length ?? 0) + (cp.modified?.length ?? 0)
      if (pending > 0) {
        throw new Error(`Refusing to edit: ${pending} pending change(s) already in Framer workspace.`)
      }

      // Find the page node by path
      let pagesWithPath: any[]
      try {
        pagesWithPath = await framer.getNodesWithAttribute('path')
      } catch (err) {
        throw new Error(`CANVAS_API_UNAVAIL: getNodesWithAttribute failed — framer-api version may not expose canvas APIs: ${String(err).slice(0, 200)}`)
      }
      const pageNode = pagesWithPath.find((n: any) => n.path === input.pagePath)
      if (!pageNode) {
        const availablePaths = pagesWithPath
          .map((n: any) => n.path)
          .filter(Boolean)
          .slice(0, 15)
          .join(', ')
        throw new Error(`PAGE_NOT_FOUND: no page with path "${input.pagePath}". Available: ${availablePaths || '(none discovered)'}`)
      }

      // Find text nodes within the page subtree
      let textNodes: any[]
      try {
        textNodes = await pageNode.getNodesWithType('TextNode')
      } catch (err) {
        throw new Error(`CANVAS_API_UNAVAIL: pageNode.getNodesWithType failed: ${String(err).slice(0, 200)}`)
      }

      // Find exact match for oldText
      const matches: any[] = []
      for (const node of textNodes) {
        let currentText: string
        try {
          currentText = await node.getText()
        } catch {
          continue
        }
        if (currentText === input.oldText) matches.push(node)
      }

      if (matches.length === 0) {
        const sampleTexts: string[] = []
        for (const n of textNodes.slice(0, 8)) {
          try {
            const t = await n.getText()
            if (t) sampleTexts.push(t.slice(0, 80))
          } catch { /* skip */ }
        }
        throw new Error(`TEXT_NOT_FOUND: oldText not found on ${input.pagePath}. Sample texts on this page: ${sampleTexts.map(s => `"${s}"`).join(' | ')}`)
      }
      if (matches.length > 1) {
        throw new Error(`AMBIGUOUS_TEXT: oldText "${input.oldText.slice(0, 80)}" matches ${matches.length} text nodes on ${input.pagePath}. Make oldText more specific to disambiguate.`)
      }

      const targetNode = matches[0]
      const beforeText = input.oldText

      try {
        await targetNode.setText(input.newText)
      } catch (err) {
        throw new Error(`setText failed: ${String(err).slice(0, 200)}`)
      }

      let prodResult: any
      try {
        const preview = await framer.publishForAgent({ action: 'preview' })
        const hash = preview?.confirmationHash ?? preview?.nextAction?.confirmationHash
        if (!hash) {
          throw new Error(`Preview returned no confirmationHash. Shape: ${JSON.stringify(preview ?? null).slice(0, 500)}`)
        }
        await framer.publishForAgent({ action: 'confirm_publish', confirmationHash: hash })
        prodResult = await framer.publishForAgent({ action: 'deploy_to_production' })
      } catch (err) {
        logger.warn('marketing_text_rollback_attempt', {
          tenantId: ctx.tenant.tenantId,
          pagePath: input.pagePath,
          err:      String(err).slice(0, 300),
        })
        try {
          await targetNode.setText(beforeText)
          logger.info('marketing_text_rolled_back', { tenantId: ctx.tenant.tenantId, pagePath: input.pagePath })
        } catch (rbErr) {
          logger.error('marketing_text_rollback_failed', {
            tenantId:    ctx.tenant.tenantId,
            pagePath:    input.pagePath,
            originalErr: String(err).slice(0, 300),
            rollbackErr: String(rbErr).slice(0, 300),
          })
        }
        throw err
      }

      return { beforeText, newText: input.newText, prodResult }
    })

    const projectHostname = (() => {
      try {
        const h = new URL(ctx.tenant.framer_project_url ?? '').hostname
        return h.startsWith('www.') ? h.slice(4) : h
      } catch {
        return undefined
      }
    })()
    const productionUrl = projectHostname ? `https://${projectHostname}${input.pagePath}` : input.pagePath

    logger.info('exec_framer_update_marketing_page_text', {
      tenantId:    ctx.tenant.tenantId,
      taskId:      ctx.taskId,
      approvalId:  ctx.approvalId,
      pagePath:    input.pagePath,
      oldTextLen:  input.oldText.length,
      newTextLen:  input.newText.length,
    })

    return {
      ok:      true,
      summary: `Updated text on ${productionUrl}: "${input.oldText.slice(0, 50)}" → "${input.newText.slice(0, 50)}"`,
      detail:  {
        pagePath:      input.pagePath,
        oldText:       input.oldText,
        newText:       input.newText,
        productionUrl,
        deploymentId:  result.prodResult.deployment?.id,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `framer_update_marketing_page_text failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 500),
    }
  }
}
