// src/feedback/handler.ts
//
// Top-level orchestration for thread-feedback refinement.
//
// Called from slackManager's app.event('message') handler when an operator
// types a reply in a thread under one of our run anchors.
//
// Routes Stage 1 vs Stage 2 to the right write path, posts the result back
// to the same thread.

import type { App } from '@slack/bolt'
import { pool } from '../memory/postgres'
import { logger } from '../logger'
import { getTenant } from '../tenants/registry'
import { findPendingPitchForTask, updateApprovalToolInput } from './state'
import { runRefiner, type RefinerOutput } from './refiner'
import { rewriteBlogItem } from './framer-rewrite'

export interface ThreadFeedbackInput {
  app:       App
  tenantId:  string
  taskId:    string
  channelId: string
  threadTs:  string
  feedback:  string
  userId:    string
}

export async function handleThreadFeedback(input: ThreadFeedbackInput): Promise<void> {
  const { app, tenantId, taskId, channelId, threadTs, feedback, userId } = input

  // 1. Find the pending pitch in this thread.
  const pending = await findPendingPitchForTask(pool, taskId)
  if (!pending) {
    await postThreadReply(app, channelId, threadTs,
      `I don't see a pending pitch in this thread to refine. If you're responding to an old approval, the action has likely already been resolved.`)
    return
  }

  logger.info('thread_feedback_received', {
    tenantId, taskId, approvalId: pending.id, toolName: pending.toolName, userId,
    feedbackSnippet: feedback.slice(0, 200),
  })

  // 2. Determine stage + load current pitch fields.
  let stage:        'stage1' | 'stage2'
  let currentTitle: string
  let currentContent: string
  let currentWhy:   string
  let currentSlug:  string
  let currentImage: string | undefined
  let stage2ItemId: string | undefined

  if (pending.toolName === 'approve_blog_pitch') {
    stage = 'stage1'
    const ti = pending.toolInput as Record<string, unknown>
    currentTitle   = String(ti.title ?? '')
    currentContent = String(ti.content ?? '')
    currentWhy     = String(ti.whyThisTopic ?? '')
    currentSlug    = String(ti.slug ?? '')
    currentImage   = ti.imageUrl ? String(ti.imageUrl) : undefined
  } else if (pending.toolName === 'framer_confirm_publish') {
    stage = 'stage2'
    // Stage 2's tool_input has only {itemId, confirmationHash, slug, title}.
    // We need the current content from the Framer item itself (which is the
    // live source of truth post-Stage-1-executor).
    const ti = pending.toolInput as Record<string, unknown>
    stage2ItemId = String(ti.itemId ?? '')
    currentSlug  = String(ti.slug  ?? '')
    currentTitle = String(ti.title ?? '')

    // Pull live content from Framer
    const tenant = await getTenant(tenantId)
    const fr = await import('../integrations/framer/client')
    try {
      const item = await fr.getBlogItemContent(tenant, stage2ItemId)
      currentContent = item.content
      currentTitle   = item.title || currentTitle  // prefer Framer's title if richer
      currentImage   = item.imageUrl
    } catch (err) {
      logger.error('thread_feedback_framer_read_failed', { tenantId, taskId, itemId: stage2ItemId, err: String(err) })
      await postThreadReply(app, channelId, threadTs,
        `Couldn't read the current draft from Framer — refinement aborted. Try again, or reject this approval and start over.`)
      return
    }
    currentWhy = ''  // not tracked at Stage 2; refiner will ignore if empty
  } else {
    // Shouldn't happen given findPendingPitchForTask filters, but defensive.
    await postThreadReply(app, channelId, threadTs,
      `The pending action in this thread isn't a refinable pitch (tool: ${pending.toolName}).`)
    return
  }

  // 3. Call the refiner.
  let result: RefinerOutput
  try {
    result = await runRefiner({
      stage,
      title:        currentTitle,
      whyThisTopic: currentWhy,
      content:      currentContent,
      feedback,
    })
  } catch (err) {
    logger.error('thread_feedback_refiner_failed', { tenantId, taskId, err: String(err) })
    await postThreadReply(app, channelId, threadTs,
      `Refinement failed — I couldn't process that feedback. Try rephrasing, or reject this approval and start fresh.`)
    return
  }

  logger.info('thread_feedback_refiner_result', {
    tenantId, taskId, approvalId: pending.id, action: result.action,
    changeSummarySnippet: result.changeSummary.slice(0, 200),
  })

  // 4. Apply the result.
  if (result.action === 'clarify') {
    await postThreadReply(app, channelId, threadTs,
      `🤔 ${result.changeSummary}`)
    return
  }
  if (result.action === 'reject') {
    await postThreadReply(app, channelId, threadTs,
      `⚠️ ${result.changeSummary}`)
    return
  }

  // result.action === 'refined'
  const updated = result.updated ?? {}
  if (!updated.title && !updated.content && !updated.whyThisTopic) {
    // Refiner claimed refined but produced no updates — degrade to clarify.
    await postThreadReply(app, channelId, threadTs,
      `🤔 I thought I had a refinement but produced no concrete changes — could you be more specific about what to update?`)
    return
  }

  if (stage === 'stage1') {
    // Update tool_input in DB. The executor reads this when Stage 1 is approved.
    const fieldsToMerge: Record<string, unknown> = {}
    if (updated.title)        fieldsToMerge.title        = updated.title
    if (updated.content)      fieldsToMerge.content      = updated.content
    if (updated.whyThisTopic) fieldsToMerge.whyThisTopic = updated.whyThisTopic
    await updateApprovalToolInput(pool, pending.id, fieldsToMerge)
    await postThreadReply(app, channelId, threadTs,
      `✏️ Updated the pitch — ${result.changeSummary}\n\nThe approval card above reflects this. Approve when ready.`)
    return
  }

  // stage === 'stage2': rewrite the Framer draft.
  try {
    const tenant = await getTenant(tenantId)
    const rewriteResult = await rewriteBlogItem({
      tenant,
      oldItemId: stage2ItemId!,
      slug:      currentSlug,
      title:     updated.title   ?? currentTitle,
      content:   updated.content ?? currentContent,
      imageUrl:  currentImage,
    })
    // Update Stage 2 approval row with new itemId + confirmationHash
    await updateApprovalToolInput(pool, pending.id, {
      itemId:           rewriteResult.newItemId,
      confirmationHash: rewriteResult.confirmationHash,
      title:            updated.title ?? currentTitle,
    })
    // Build a fresh preview URL for the new itemId
    const projectUrl = tenant.framer_project_url ?? ''
    const newPreviewUrl = projectUrl
      ? `${projectUrl}${projectUrl.includes('?') ? '&' : '?'}item=${encodeURIComponent(rewriteResult.newItemId)}`
      : ''
    const previewLine = newPreviewUrl
      ? `\n\n*New preview:* <${newPreviewUrl}|Open the updated draft in Framer>`
      : ''
    await postThreadReply(app, channelId, threadTs,
      `✏️ Updated the Framer draft — ${result.changeSummary}${previewLine}\n\nRefresh your preview tab, then approve the card above when ready.`)
  } catch (err) {
    logger.error('thread_feedback_framer_rewrite_failed', { tenantId, taskId, err: String(err) })
    await postThreadReply(app, channelId, threadTs,
      `⚠️ I produced a refinement but couldn't apply it to Framer (${String(err).slice(0, 200)}). Reject this approval and start fresh.`)
  }
}

async function postThreadReply(app: App, channelId: string, threadTs: string, text: string): Promise<void> {
  try {
    await app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text })
  } catch (err) {
    logger.error('thread_feedback_post_failed', { channelId, threadTs, err: String(err) })
  }
}
