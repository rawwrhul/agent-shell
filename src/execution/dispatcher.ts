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
import {
  execWebflowConfirmPublish,
  execWebflowRollbackDraft,
  execWebflowApproveBlogPitch,
  execWebflowUpdateBlogMeta,
  execWebflowUpdateBlogBody,
  execWebflowAddBlogAltText,
  execWebflowAddInternalLink,
  execWebflowUpdatePageMeta,
  execWebflowUpdateMarketingPageText,
} from '../integrations/webflow/executor'
import {
  execAdsAddNegativeKeywords,
  execAdsSetBidModifiers,
  execAdsEditKeywords,
  execAdsChangeBids,
  execAdsChangeBudget,
  execAdsAddKeywords,
  execAdsCreateAdGroup,
  execAdsCreateCampaign,
  execAdsUpdateAdCopy,
} from '../integrations/googleads/executor'

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
  // CMS-routed: Webflow tenants (integrations includes 'webflow') draft into
  // the Webflow CMS and queue Stage 2 'webflow_confirm_publish'; everyone
  // else takes the original Framer path. One tenant has exactly one CMS —
  // tenantIntegrations gating prevents dispatch ambiguity.
  'approve_blog_pitch':        (i, c) =>
    (Array.isArray(c.tenant.integrations) && c.tenant.integrations.includes('webflow'))
      ? execWebflowApproveBlogPitch(i as unknown as Parameters<typeof execWebflowApproveBlogPitch>[0], c)
      : execApproveBlogPitch(i as unknown as Parameters<typeof execApproveBlogPitch>[0], c),

  // Webflow write executors (mirror of the framer_* set; every write is
  // GET-verified after the fact — Webflow can 200 without persisting).
  'webflow_confirm_publish':   (i, c) => execWebflowConfirmPublish(i as unknown as Parameters<typeof execWebflowConfirmPublish>[0], c),
  'webflow_rollback_draft':    (i, c) => execWebflowRollbackDraft(i as unknown as Parameters<typeof execWebflowRollbackDraft>[0], c),
  'webflow_update_blog_meta':  (i, c) => execWebflowUpdateBlogMeta(i as unknown as Parameters<typeof execWebflowUpdateBlogMeta>[0], c),
  'webflow_update_blog_body':  (i, c) => execWebflowUpdateBlogBody(i as unknown as Parameters<typeof execWebflowUpdateBlogBody>[0], c),
  'webflow_add_blog_alt_text': (i, c) => execWebflowAddBlogAltText(i as unknown as Parameters<typeof execWebflowAddBlogAltText>[0], c),
  'webflow_add_internal_link': (i, c) => execWebflowAddInternalLink(i as unknown as Parameters<typeof execWebflowAddInternalLink>[0], c),
  'webflow_update_page_meta':  (i, c) => execWebflowUpdatePageMeta(i as unknown as Parameters<typeof execWebflowUpdatePageMeta>[0], c),
  'webflow_update_marketing_page_text': (i, c) => execWebflowUpdateMarketingPageText(i as unknown as Parameters<typeof execWebflowUpdateMarketingPageText>[0], c),

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

  // Google Ads (chunk 1b) - HITL-gated mutations. Input validated by zod
  // inside the executor; TenantAdsClient.mutate requires the approvalId.
  'ads_add_negative_keywords': (i, c) => execAdsAddNegativeKeywords(i, c),
  'ads_set_bid_modifiers':     (i, c) => execAdsSetBidModifiers(i, c),
  'ads_edit_keywords':         (i, c) => execAdsEditKeywords(i, c),

  // Google Ads (chunks 1d+1e) - bids, budget, expansion, ad copy. Same
  // spine: zod validation + live pre-reads inside the executor, mutation
  // unlocked only by ctx.approvalId.
  'ads_change_bids':           (i, c) => execAdsChangeBids(i, c),
  'ads_change_budget':         (i, c) => execAdsChangeBudget(i, c),
  'ads_add_keywords':          (i, c) => execAdsAddKeywords(i, c),
  'ads_create_ad_group':       (i, c) => execAdsCreateAdGroup(i, c),
  'ads_create_campaign':       (i, c) => execAdsCreateCampaign(i, c),
  'ads_update_ad_copy':        (i, c) => execAdsUpdateAdCopy(i, c),
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
