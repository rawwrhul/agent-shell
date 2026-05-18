// src/execution/dispatcher.ts
//
// Routes an approved action's tool_name to the correct integration handler.

import type { IntegrationContext, ExecutionResult } from '../integrations/types'
import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
  execFramerUpdateBlogMeta,
  execFramerUpdateBlogBody,
  execFramerAddSiteSchema,
  execFramerAddBlogAltText,
  execFramerAddInternalLink,
  execFramerUpdateMarketingPageText,
} from '../integrations/framer/executor'
import { execGscSubmitSitemap } from '../integrations/gsc/executor'

// Map of tool_name → handler.
// When the agent proposes an action via `propose_action`, the toolName field on
// the approval determines which handler executes. Handler signature is uniform:
// (input, ctx) → ExecutionResult.
const HANDLERS: Record<
  string,
  (input: Record<string, unknown>, ctx: IntegrationContext) => Promise<ExecutionResult>
> = {
  // Framer — two-phase commit:
  //   1) Agent calls framer_draft_blog_post (a tool, not an executor) which
  //      creates the CMS item and returns a confirmationHash.
  //   2) Agent files propose_action with toolName='framer_confirm_publish'.
  //   3) Operator approves → this executor commits to production.
  //   4) Rejection / cleanup → framer_rollback_draft removes the draft item.
  'framer_confirm_publish':    (i, c) => execFramerConfirmPublish(i as unknown as Parameters<typeof execFramerConfirmPublish>[0], c),
  'framer_rollback_draft':     (i, c) => execFramerRollbackDraft(i as unknown as Parameters<typeof execFramerRollbackDraft>[0], c),

  // Atomic create + publish — agent files this directly via propose_action
  // with FULL content in toolInput. On approve: create CMS item + publish in one shot.
  // On reject: no-op (nothing was created yet).
  'framer_create_and_publish_blog_post': (i, c) =>
    execFramerCreateAndPublishBlogPost(i as unknown as Parameters<typeof execFramerCreateAndPublishBlogPost>[0], c),

  // Manual operator task — for schema markup, internal linking, copy edits.
  // The agent describes what needs doing; the operator does it manually in Framer.
  'manual_operator_task':      (i, c) =>
    execManualOperatorTask(i as unknown as Parameters<typeof execManualOperatorTask>[0], c),

  // Phase 8: two-stage approval — agent files approve_blog_pitch.
  // On approve, executor creates Framer draft + queues Stage 2 (framer_confirm_publish).
  'approve_blog_pitch':        (i, c) =>
    execApproveBlogPitch(i as unknown as Parameters<typeof execApproveBlogPitch>[0], c),

  // P0 single-approval write executors
  'framer_update_blog_meta':   (i, c) =>
    execFramerUpdateBlogMeta(i as unknown as Parameters<typeof execFramerUpdateBlogMeta>[0], c),

  'framer_update_blog_body':   (i, c) =>
    execFramerUpdateBlogBody(i as unknown as Parameters<typeof execFramerUpdateBlogBody>[0], c),

  'framer_add_site_schema':    (i, c) =>
    execFramerAddSiteSchema(i as unknown as Parameters<typeof execFramerAddSiteSchema>[0], c),

  'framer_add_blog_alt_text':  (i, c) =>
    execFramerAddBlogAltText(i as unknown as Parameters<typeof execFramerAddBlogAltText>[0], c),

  'framer_add_internal_link':  (i, c) =>
    execFramerAddInternalLink(i as unknown as Parameters<typeof execFramerAddInternalLink>[0], c),

  'framer_update_marketing_page_text': (i, c) =>
    execFramerUpdateMarketingPageText(i as unknown as Parameters<typeof execFramerUpdateMarketingPageText>[0], c),

  // GSC
  'gsc_submit_sitemap':        (i, c) => execGscSubmitSitemap(i as unknown as Parameters<typeof execGscSubmitSitemap>[0], c),
}

export async function dispatchExecution(
  toolName: string,
  input:    Record<string, unknown>,
  ctx:      IntegrationContext,
): Promise<ExecutionResult> {
  const handler = HANDLERS[toolName]
  if (!handler) {
    return {
      ok: false,
      summary: `No execution handler registered for tool "${toolName}"`,
      error:   `unknown tool_name: ${toolName}`,
    }
  }
  return handler(input, ctx)
}

export function isExecutableToolName(toolName: string): boolean {
  return toolName in HANDLERS
}
