// src/integrations/surfer/tools.ts
//
// SurferSEO agent tools — v2 API (verified live 2026-07-14 against
// app.surferseo.com/llms.txt).
//
// One tool survives: surfer_content_guidelines, now backed by the REAL v2
// guidelines endpoints (seo_guidelines/terms + /structure) so the drafter
// writes against actual SERP-derived term lists and word-count targets.
//
// REMOVED (2026-07-14): surfer_detect_ai, surfer_humanize_content — those
// features have "No documented operations" in Surfer's API at any tier;
// the old endpoints 404'd in production. surfer_score_content removed as
// an agent tool: scoring costs a Content Editor credit per keyword and is
// the publish gate's job (revision.ts), not a reasoning-loop toy.
//
// Guidelines are cached 30d per (keyword, location): a fresh editor costs
// a Surfer credit and SERP-derived guidance is stable over weeks.

import Anthropic from '@anthropic-ai/sdk'
import { pool } from '../../memory/postgres'
import { cachedJson, TTL } from '../../core/cache/cached-fetch'
import { createAndAwaitEditorV2, getGuidelinesV2 } from './client'
import type { TenantConfig } from '../../tenants/types'

export const SURFER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'surfer_content_guidelines',
    description: 'SurferSEO content guidelines for a target keyword: prominent terms to include (with target ranges and heading flags), plus word/heading/paragraph/image count targets — derived from live top-ranking pages. Use BEFORE drafting or rewriting: the publish gate scores against the same SERP analysis, so drafting against these guidelines is what makes articles pass. Slow on cache miss (up to ~3 min, Surfer analyzes the SERP; costs one credit). Cached 30d per keyword.',
    input_schema: {
      type: 'object',
      properties: {
        keyword:  { type: 'string', description: 'Primary target keyword' },
        location: { type: 'string', description: 'SERP location (default "Australia")' },
      },
      required: ['keyword'],
    },
  },
]

export function isSurferToolName(name: string): boolean {
  return name.startsWith('surfer_')
}

export async function executeSurferTool(
  name:   string,
  input:  Record<string, unknown>,
  tenant: TenantConfig,
): Promise<string> {
  try {
    const keyword  = String(input.keyword || '').trim().toLowerCase()
    const location = String(input.location || 'Australia')

    switch (name) {
      case 'surfer_content_guidelines': {
        if (!keyword) return 'surfer_content_guidelines error: keyword is required'
        const { value, cacheHit } = await cachedJson({
          pool, source: 'surfer', tenantId: tenant.tenantId,
          key: `guidelines-v2:${location}:${keyword}`, ttlSeconds: TTL.SURFER_GUIDELINES,
          fetcher: async () => {
            const editorId = await createAndAwaitEditorV2(keyword, location)
            const g = await getGuidelinesV2(editorId)
            return { editorId, ...g }
          },
        })
        const obj = (value && typeof value === 'object') ? value as Record<string, unknown> : { result: value }
        return JSON.stringify({ cacheHit, ...obj }, null, 2)
      }

      // Removed tools return a clear redirect instead of a dead 404.
      case 'surfer_detect_ai':
      case 'surfer_humanize_content':
        return `${name} is no longer available: Surfer's API does not expose this feature at any tier. Proceed without it — the publish gate scores content quality.`
      case 'surfer_score_content':
        return `surfer_score_content is no longer an agent tool: the publish gate scores every article automatically against Surfer's SERP analysis. Focus on drafting against surfer_content_guidelines instead.`

      default:
        return `Unknown Surfer tool: ${name}`
    }
  } catch (err) {
    return `${name} error: ${String(err).slice(0, 400)}`
  }
}
