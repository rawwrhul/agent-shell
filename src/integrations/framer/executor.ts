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
import type { IntegrationContext, ExecutionResult } from '../types'

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

    const result = await fr.confirmPublish(ctx.tenant, input.confirmationHash)
    logger.info('exec_framer_confirm_publish', {
      tenantId:     ctx.tenant.tenantId,
      taskId:       ctx.taskId,
      approvalId:   ctx.approvalId,
      deploymentId: result.deployment?.id,
      slug:         input.slug,
    })

    const productionHost = result.hostnames?.find(h => h.type === 'custom' && h.isPublished)?.hostname
    const summary = input.title
      ? `Published "${input.title}" to ${productionHost ?? 'production'}`
      : `Published deployment ${result.deployment?.id ?? '(unknown)'} to ${productionHost ?? 'production'}`

    return {
      ok:      true,
      summary,
      detail:  {
        ...input,
        result,
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
      whyPriority:     input.whyThisTopic ?? 'Draft ready for review in Framer.',
      slackChannelId:  null as unknown as string | undefined,  // presenter looks up from slack_runs
      previewUrl:      projectUrl,                             // links to Framer project for draft review
      parentApprovalId: stage1ApprovalId,
    })

    return {
      ok:      true,
      summary: `Draft created in Framer. Stage 2 approval posted (id ${stage2.id.slice(0, 8)}).`,
      detail: {
        itemId:           draft.itemId,
        slug:             input.slug,
        confirmationHash: draft.preview.confirmationHash,
        stage2ApprovalId: stage2.id,
        framerProjectUrl: projectUrl,
        productionUrl:    `https://tarino.au/resources/${input.slug}`,
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
