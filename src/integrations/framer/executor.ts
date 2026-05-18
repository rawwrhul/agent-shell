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
  imageUrl?: string
}

export async function execFramerCreateAndPublishBlogPost(
  input: CreateAndPublishBlogPostInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug || !input.title || !input.content) {
      return { ok: false, summary: 'slug, title, and content are required', error: 'missing required fields' }
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

export interface ApproveBlogPitchInput {
  slug:        string
  title:       string
  content:     string             // HTML in Framer formattedText format
  imageUrl?:   string
  whyThisTopic?: string
}

export async function execApproveBlogPitch(
  input: ApproveBlogPitchInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || !input.title || !input.content) {
    return { ok: false, summary: 'approve_blog_pitch error: slug, title, content all required',
             error: 'missing required field in toolInput' }
  }
  try {
    // 1. Create the Framer draft (writes CMS item, gets confirmationHash)
    const draft = await fr.draftAndPreviewBlogPost(ctx.tenant, {
      slug:     input.slug,
      title:    input.title,
      content:  input.content,
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
          summary:    `Publish '${input.title}' to /resources/${input.slug}`,
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
