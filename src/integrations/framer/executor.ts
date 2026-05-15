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

