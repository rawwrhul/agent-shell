// src/core/opportunity-bank/ad-hoc-match.ts
//
// Classify an ad-hoc Slack prompt against the known opportunity-type
// registry. Returns { types, confidence } so the slackManager can decide
// whether to serve from the bank or trigger fresh discovery.
//
// Why a registry instead of free-form LLM output: an LLM given total
// freedom will invent types we don't actually have rows for, so the bank
// query returns empty even when there are relevant rows. Constraining to
// known types keeps the lookup deterministic.

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../config'
import { logger } from '../../logger'
import { callAnthropic } from '../../lib/anthropic-call'
import { AdHocMatch, AD_HOC_CONFIDENCE_THRESHOLD } from './types'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Known opportunity types we actively file. Extend as new discovery
 * skills land. The classifier is constrained to pick from this list.
 *
 * Source of truth is here, not the DB enum — the DB type column is
 * deliberately free-form to allow gradual rollout of new types without
 * a migration.
 */
export const KNOWN_OPPORTUNITY_TYPES: ReadonlyArray<{
  type:        string
  description: string
}> = [
  // Audit-driven (SEO-2)
  { type: 'fix_duplicate_titles',            description: 'Multiple pages sharing the same <title>' },
  { type: 'fix_duplicate_meta_descriptions', description: 'Multiple pages sharing the same meta description' },
  { type: 'fix_broken_internal_link',        description: 'Internal link pointing to a 404 / non-200' },
  { type: 'fix_canonical_conflict',          description: 'Canonical tag pointing somewhere unexpected' },
  { type: 'add_internal_link_to_orphan',     description: 'Page has no inbound internal links' },
  { type: 'add_missing_meta_description',    description: 'Page missing a meta description' },
  { type: 'add_missing_h1',                  description: 'Page missing an H1 tag' },
  { type: 'fix_multiple_h1',                 description: 'Page has more than one H1' },
  { type: 'add_to_sitemap',                  description: 'Indexable page missing from sitemap.xml' },
  { type: 'remove_from_sitemap',             description: 'Non-page resource appearing in sitemap.xml' },

  // Content generation
  { type: 'create_new_blog_post',            description: 'Topic gap that warrants a new blog post' },
  { type: 'create_landing_page',             description: 'Commercial/service page worth creating' },
  { type: 'refresh_stale_content',           description: 'Existing page on a fast-moving topic that\'s gone stale' },
  { type: 'expand_copy',                     description: 'Existing page needs more depth / sections' },

  // Internal linking
  { type: 'add_internal_link',               description: 'Two related pages should be cross-linked' },
  { type: 'improve_internal_anchor_text',    description: 'Internal links use weak/generic anchor text' },

  // Metadata
  { type: 'optimise_title_tag',              description: 'Title could be more click-worthy or keyword-relevant' },
  { type: 'optimise_meta_description',       description: 'Meta description could be tightened or improved' },
  { type: 'add_schema_markup',               description: 'Page missing applicable schema (FAQ, HowTo, Product, etc.)' },
  { type: 'add_image_alt_text',              description: 'Images missing alt text' },

  // Keyword research (SEO-3, future)
  { type: 'cluster_gap_fill',                description: 'Cluster has an unfilled intent bucket' },
  { type: 'target_unfilled_intent',          description: 'Known target intent currently has no matching page' },
  { type: 'resolve_cannibalization',         description: 'Multiple of our pages competing for the same query' },
  { type: 'target_featured_snippet',         description: 'Page 1 ranking but not winning the SERP feature' },

  // Competitor (SEO-4, future)
  { type: 'respond_to_competitor_move',      description: 'Competitor published something we should match' },
  { type: 'defensive_rank_loss_alert',       description: 'We lost ground on a tracked keyword' },

  // Backlinks (SEO-5, future)
  { type: 'pursue_backlink',                 description: 'A target site worth getting a link from' },
  { type: 'fix_unlinked_mention',            description: 'A site mentions the brand but doesn\'t link to us' },
  { type: 'recover_lost_backlink',           description: 'A previously-active backlink has gone away' },
  { type: 'disavow_toxic_backlink',          description: 'A toxic / spammy backlink worth disavowing' },
]

/**
 * Quick keyword-based pre-filter — if the prompt obviously doesn't relate
 * to opportunity discovery (e.g. "what's the weather"), skip the LLM call
 * and return null. Saves a haiku call for pure-chat mentions.
 */
function looksLikeOpportunityRequest(prompt: string): boolean {
  const p = prompt.toLowerCase()
  const signals = [
    'opportunit', 'find', 'show', 'list', 'audit', 'check', 'review',
    'pages', 'meta', 'title', 'description', 'h1', 'orphan', 'broken',
    'duplicate', 'canonical', 'sitemap', 'schema', 'alt text',
    'keyword', 'cluster', 'gap', 'cannibalization',
    'competitor', 'backlink', 'link', 'mention', 'pitch', 'outreach',
    'content', 'blog', 'landing', 'idea', 'refresh', 'stale',
  ]
  return signals.some((s) => p.includes(s))
}

/**
 * Match an ad-hoc Slack mention text against the opportunity-type
 * registry. Returns null if the prompt doesn't look like an opportunity
 * request, or if the classifier is below the confidence threshold.
 */
export async function matchAdHocRequest(input: {
  prompt: string
}): Promise<AdHocMatch | null> {
  const prompt = input.prompt.trim()
  if (prompt.length < 5) return null
  if (!looksLikeOpportunityRequest(prompt)) return null

  const typeList = KNOWN_OPPORTUNITY_TYPES
    .map((t) => `- ${t.type}: ${t.description}`)
    .join('\n')

  const classifierPrompt = `An operator typed this message to an SEO agent in Slack:

"""
${prompt}
"""

Decide which opportunity types from the registry below the operator is asking about. Only pick types that are clearly relevant — a vague match counts as zero. Multiple relevant types are allowed.

Registry:
${typeList}

Respond ONLY with a JSON object, no preamble:

{
  "types":      ["type_a", "type_b"],
  "confidence": 0.0
}

Confidence:
- 0.9+ — the prompt explicitly names a type or a clear synonym
- 0.7–0.9 — the prompt is asking about this category but doesn't name it
- below 0.7 — the prompt is too vague to commit to specific types; return empty types

If types is empty, set confidence to 0.`

  let parsed: AdHocMatch | null = null
  try {
    const resp = await callAnthropic(anthropic, {
      model:      CLASSIFIER_MODEL,
      max_tokens: 300,
      messages:   [{ role: 'user', content: classifierPrompt }],
    }, { label: 'adhoc-classifier' })
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
    parsed = extractMatchJson(text)
  } catch (err) {
    logger.warn('adhoc_classifier_failed', {
      err: String(err).slice(0, 200),
    })
    return null
  }

  if (!parsed) return null
  if (typeof parsed.confidence !== 'number') return null
  if (parsed.confidence < AD_HOC_CONFIDENCE_THRESHOLD) return null
  if (!Array.isArray(parsed.types) || parsed.types.length === 0) return null

  // Validate types against the registry — drop any the LLM invented.
  const knownTypeSet = new Set(KNOWN_OPPORTUNITY_TYPES.map((t) => t.type))
  const valid = parsed.types.filter((t) => typeof t === 'string' && knownTypeSet.has(t))
  if (valid.length === 0) return null

  return { types: valid, confidence: parsed.confidence }
}

function extractMatchJson(text: string): AdHocMatch | null {
  try { return JSON.parse(text) } catch { /* fall through */ }
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
  try { return JSON.parse(stripped) } catch { /* fall through */ }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* give up */ }
  }
  return null
}
