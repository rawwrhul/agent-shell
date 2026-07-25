// src/integrations/pexels/tools.ts
//
// Anthropic tool definitions for Pexels image search.
// Read-only — no propose_action gating needed. Agent uses results inline.

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import { searchPexelsPhotos } from './client'

export const PEXELS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'pexels_search',
    description:
      'Search Pexels stock photos for a hero image to accompany a blog post. ' +
      'Returns up to 10 candidate photos with URLs, photographer names, and alt text. ' +
      'USE THIS after drafting the blog post content — pick the most editorially-relevant image ' +
      'and include its src.landscape URL in the propose_action toolInput.imageUrl. ' +
      'Best practice: use a 2-4 word concrete-noun query that reflects the post subject ' +
      '(e.g. "australian small business owner laptop", "warehouse logistics team", "calculator paperwork desk") ' +
      'rather than abstract terms ("offshore hiring" returns generic globe-handshake clichés).',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type:        'string',
          description: '2-4 word concrete-noun query. Avoid abstract terms like "offshore hiring".',
        },
        orientation: {
          type:        'string',
          enum:        ['landscape', 'portrait', 'square'],
          description: 'Image orientation. Default landscape — best for blog headers.',
        },
        count: {
          type:        'integer',
          description: 'Number of candidates to return (default 10, max 30). More candidates = better choice.',
        },
      },
      required: ['query'],
    },
  },
]

const PEXELS_TOOL_NAMES = new Set(PEXELS_TOOLS.map(t => t.name))

export function isPexelsToolName(name: string): boolean {
  return PEXELS_TOOL_NAMES.has(name)
}

export async function executePexelsTool(
  name:   string,
  input:  Record<string, unknown>,
  _tenant: TenantConfig,
): Promise<string> {
  try {
    switch (name) {
      case 'pexels_search': {
        const i = input as { query: string; orientation?: 'landscape'|'portrait'|'square'; count?: number }
        if (!i.query) return 'pexels_search error: query is required'
        const result = await searchPexelsPhotos({
          query:       i.query,
          orientation: i.orientation ?? 'landscape',
          per_page:    Math.min(i.count ?? 10, 30),
        })
        // Trim the response to just what the agent needs to pick an image.
        const trimmed = result.photos.map(p => ({
          url_for_post: p.src.landscape,   // <-- pass THIS to propose_action.toolInput.imageUrl
          preview:      p.src.medium,
          alt:          p.alt,
          photographer: p.photographer,
          pexels_page:  p.url,
          width:        p.width,
          height:       p.height,
        }))
        return JSON.stringify({
          query:        i.query,
          totalResults: result.total_results,
          photos:       trimmed,
        })
      }
      default:
        return `Unknown Pexels tool: ${name}`
    }
  } catch (err) {
    return `Pexels tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
