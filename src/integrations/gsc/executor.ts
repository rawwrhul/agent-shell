// src/integrations/gsc/executor.ts
//
// Handlers for approved GSC actions.

import * as gsc from './client'
import type { IntegrationContext, ExecutionResult } from '../types'

interface SubmitSitemapInput {
  sitemapUrl: string   // full URL to the sitemap on the tenant's site
}

export async function execGscSubmitSitemap(
  input: SubmitSitemapInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.sitemapUrl) {
      return { ok: false, summary: 'sitemapUrl is required', error: 'missing sitemapUrl' }
    }
    await gsc.submitSitemap(ctx.tenant, input.sitemapUrl)
    return {
      ok: true,
      summary: `Submitted sitemap ${input.sitemapUrl} to Google`,
      detail: { sitemapUrl: input.sitemapUrl },
    }
  } catch (err) {
    return { ok: false, summary: 'Sitemap submission failed', error: String(err).slice(0, 500) }
  }
}
