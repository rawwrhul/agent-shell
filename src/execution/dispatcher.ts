// src/execution/dispatcher.ts
//
// Routes an approved action's tool_name to the correct integration handler.

import type { IntegrationContext, ExecutionResult } from '../integrations/types'
import {
  execFramerUpdatePageSeo,
  execFramerPublishPreview,
  execFramerDeployProduction,
  execFramerUpdateCmsItem,
  execFramerCreateCmsItem,
} from '../integrations/framer/executor'
import { execGscSubmitSitemap } from '../integrations/gsc/executor'

// Map of tool_name → handler.
// When the agent proposes an action via `propose_action`, the toolName field on
// the approval determines which handler executes. The handler signature is
// uniform: (input, ctx) → ExecutionResult.
const HANDLERS: Record<
  string,
  (input: Record<string, unknown>, ctx: IntegrationContext) => Promise<ExecutionResult>
> = {
  // Framer
  'framer_update_page_seo':    (i, c) => execFramerUpdatePageSeo(i as unknown as Parameters<typeof execFramerUpdatePageSeo>[0], c),
  'framer_publish_preview':    (i, c) => execFramerPublishPreview(i as unknown as Parameters<typeof execFramerPublishPreview>[0], c),
  'framer_deploy_production':  (i, c) => execFramerDeployProduction(i as unknown as Parameters<typeof execFramerDeployProduction>[0], c),
  'framer_update_cms_item':    (i, c) => execFramerUpdateCmsItem(i as unknown as Parameters<typeof execFramerUpdateCmsItem>[0], c),
  'framer_create_cms_item':    (i, c) => execFramerCreateCmsItem(i as unknown as Parameters<typeof execFramerCreateCmsItem>[0], c),

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
