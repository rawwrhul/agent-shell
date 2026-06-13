// src/integrations/surfer/tools.ts
//
// SurferSEO tools (read-only, auto-execute tier), mapped to CGS activities:
//
//   Content rewriting   → surfer_content_guidelines BEFORE rewriting an
//                         existing page: terms to include, word-count
//                         range, heading/image structure from the live SERP
//   Copy optimisation   → surfer_score_content: score draft or existing
//                         copy against the keyword's editor guidelines —
//                         this is what feeds the pre-HITL revision loop and
//                         the score shown on approval cards (Phase 4)
//   Metadata (indirect) → guidelines' prominent terms inform titles/H1s
//   Article creation    → surfer_humanize_content (OPTIONAL pass on AI
//                         drafts — see its description for the mandatory
//                         fact re-verification step) + surfer_detect_ai
//                         (read-only signal for the approval card)
//
// Guidelines are cached 30d per (keyword, location): a fresh editor costs
// a Surfer credit and SERP-derived guidance is stable over weeks. Scores
// are NEVER cached — content varies per call.
//
// ⚠️ SHAPE NOTE: the scoring call follows Surfer's content-import flow but
// exact request/response field names come from your plan's Swagger docs.
// If surfer_score_content errors with 404/422, run `npm run vendor:check`
// (prints raw shapes) and paste the relevant Swagger endpoints to finalize
// the mapping — the client is built to make that a 5-minute fix.

import Anthropic from '@anthropic-ai/sdk'
import { pool } from '../../memory/postgres'
import { cachedJson, TTL } from '../../core/cache/cached-fetch'
import { createAndAwaitContentEditor, surferRequest } from './client'
import type { TenantConfig } from '../../tenants/types'

export const SURFER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'surfer_content_guidelines',
    description: 'SurferSEO content guidelines for a target keyword: prominent terms to include (prioritised by relevance), word-count range, heading/paragraph/image structure — derived from live top-ranking pages. Use BEFORE rewriting a page or drafting copy. [Content rewriting + Copy optimisation] Slow on cache miss (up to ~2 min, Surfer scrapes the SERP). Cached 30d per keyword.',
    input_schema: {
      type: 'object',
      properties: {
        keyword:  { type: 'string', description: 'Primary target keyword' },
        location: { type: 'string', description: 'SERP location (default "Australia")' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'surfer_humanize_content',
    description: 'Rewrite AI-drafted text via SurferSEO Humanizer to read more naturally while preserving meaning. ⚠️ KNOWN FAILURE MODE: humanizers can introduce semantic drift and vague-out or drop specific statistics and factual claims. ALWAYS: (1) run this BEFORE surfer_score_content (it changes term coverage), (2) re-verify every number, name, and claim against the pre-humanized draft afterward, (3) surface both versions exist in your output so the operator knows a humanize pass ran. Use only when the tenant wants it — never by default. [Article creation] Not cached.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The AI-drafted text to humanize' },
      },
      required: ['content'],
    },
  },
  {
    name: 'surfer_detect_ai',
    description: 'Run SurferSEO AI Detector on a piece of content. Returns the detection assessment — a read-only quality signal to include alongside the Content Score when proposing content for approval. [Article creation + Copy optimisation] Not cached.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text to check' },
      },
      required: ['content'],
    },
  },
  {
    name: 'surfer_score_content',
    description: 'Score a piece of content (draft or existing page copy) against SurferSEO guidelines for a keyword. Returns the Content Score (aim 70+, or 5-10 above the top competitor) plus term coverage. Use AFTER drafting/rewriting to verify before proposing for approval. [Copy optimisation + Content rewriting] Not cached — content varies.',
    input_schema: {
      type: 'object',
      properties: {
        keyword:  { type: 'string', description: 'Target keyword (an editor for it will be created/reused)' },
        content:  { type: 'string', description: 'The HTML or plain-text content to score' },
        location: { type: 'string', description: 'SERP location (default "Australia")' },
      },
      required: ['keyword', 'content'],
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
          key: `guidelines:${location}:${keyword}`, ttlSeconds: TTL.SURFER_GUIDELINES,
          fetcher: () => createAndAwaitContentEditor(keyword, location),
        })
        const obj = (value && typeof value === 'object') ? value as Record<string, unknown> : { result: value }
        return JSON.stringify({ cacheHit, ...obj }, null, 2)
      }

      case 'surfer_humanize_content': {
        const content = String(input.content || '')
        if (!content) return 'surfer_humanize_content error: content is required'
        const res = await surferRequest('POST', '/humanize', { content, text: content })
        const obj = (res && typeof res === 'object') ? res as Record<string, unknown> : { result: res }
        return JSON.stringify({
          ...obj,
          reminder: 'Re-verify all facts, statistics and names against the original draft, then re-run surfer_score_content before proposing for approval.',
        }, null, 2)
      }

      case 'surfer_detect_ai': {
        const content = String(input.content || '')
        if (!content) return 'surfer_detect_ai error: content is required'
        const res = await surferRequest('POST', '/ai_detector', { content, text: content })
        const obj = (res && typeof res === 'object') ? res as Record<string, unknown> : { result: res }
        return JSON.stringify(obj, null, 2)
      }

      case 'surfer_score_content': {
        const content = String(input.content || '')
        if (!keyword) return 'surfer_score_content error: keyword is required'
        if (!content) return 'surfer_score_content error: content is required'

        // Reuse (or create) the cached editor for this keyword, then submit
        // the content against it for scoring.
        const { value: editor } = await cachedJson({
          pool, source: 'surfer', tenantId: tenant.tenantId,
          key: `guidelines:${location}:${keyword}`, ttlSeconds: TTL.SURFER_GUIDELINES,
          fetcher: () => createAndAwaitContentEditor(keyword, location),
        })
        const e = editor as Record<string, unknown>
        const id = e.id ?? (e as { content_editor?: { id?: unknown } }).content_editor?.id
        if (id === undefined) {
          return `surfer_score_content error: could not resolve editor id from response (keys: ${Object.keys(e).join(', ')}). Run npm run vendor:check and finalize the client field mapping.`
        }
        const scored = await surferRequest('POST', `/content_editors/${id}/content_score`, { content })
        const sObj = (scored && typeof scored === 'object') ? scored as Record<string, unknown> : { result: scored }
        return JSON.stringify({ keyword, editorId: id, ...sObj }, null, 2)
      }

      default:
        return `Unknown Surfer tool: ${name}`
    }
  } catch (err) {
    return `${name} error: ${String(err).slice(0, 400)}`
  }
}
