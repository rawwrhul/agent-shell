#!/usr/bin/env python3
"""
phase7-patch.py — Pexels hero images + Framer image field + prompt upgrades.

Run from project root after Phase 6 has deployed.

Changes (idempotent):
  1. NEW src/integrations/pexels/client.ts  — Pexels API wrapper
  2. NEW src/integrations/pexels/tools.ts   — pexels_search agent tool
  3. src/integrations/types.ts              — add 'pexels' to IntegrationKind
  4. src/integrations/index.ts              — register PEXELS_TOOLS in toolbelt
  5. src/integrations/framer/client.ts      — resolve Image field, write imageUrl
  6. src/agents/subagent.ts                 — voice reference + hero image + internal links
"""
from __future__ import annotations
import sys, re
from pathlib import Path

ROOT = Path.cwd()
assert (ROOT / 'package.json').exists() and (ROOT / 'src').exists(), 'Run from project root.'

def must_read(p: Path) -> str:
    if not p.exists(): sys.exit(f'fatal: file missing: {p}')
    return p.read_text()

def must_replace_once(text: str, anchor: str, new: str, where: str) -> str:
    if anchor not in text:
        sys.exit(f'fatal: anchor not found in {where}:\n--- anchor ---\n{anchor[:600]}\n--- end ---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

# ── 1. NEW: src/integrations/pexels/client.ts ───────────────────────────────
P = ROOT / 'src/integrations/pexels/client.ts'
P.parent.mkdir(parents=True, exist_ok=True)
if P.exists() and 'searchPexelsPhotos' in P.read_text():
    print('[1/6] pexels/client.ts already exists — skipping')
else:
    P.write_text('''// src/integrations/pexels/client.ts
//
// Pexels API wrapper. Used by the pexels_search agent tool to fetch hero
// images for blog posts. Free tier: 200 requests/hour, no attribution legally
// required (appreciated but not enforced).
//
// API key is global (one per Anthropic install, not per tenant) via the
// PEXELS_API_KEY env var. Stock photo APIs don't need per-tenant scoping.

import { logger } from '../../logger'

export interface PexelsPhoto {
  id:           number
  width:        number
  height:       number
  url:          string          // Pexels page URL (for attribution if shown)
  photographer: string
  photographer_url: string
  alt:          string
  src: {
    original:  string
    large2x:   string
    large:     string
    medium:    string
    small:     string
    portrait:  string
    landscape: string
    tiny:      string
  }
}

export interface PexelsSearchResult {
  photos:        PexelsPhoto[]
  total_results: number
  page:          number
  per_page:      number
}

export interface PexelsSearchOptions {
  query:       string
  orientation?: 'landscape' | 'portrait' | 'square'
  per_page?:   number       // default 10, max 80
  page?:       number       // default 1
}

const PEXELS_BASE = 'https://api.pexels.com/v1'

function apiKey(): string {
  const k = process.env.PEXELS_API_KEY
  if (!k) {
    throw new Error(
      'PEXELS_API_KEY env var is not set. Provision it via Cloud Run secrets ' +
      '(e.g. `gcloud run services update cgs-agent-shell --update-secrets=PEXELS_API_KEY=pexels-api-key:latest`).'
    )
  }
  return k
}

export async function searchPexelsPhotos(opts: PexelsSearchOptions): Promise<PexelsSearchResult> {
  const params = new URLSearchParams()
  params.set('query', opts.query)
  if (opts.orientation) params.set('orientation', opts.orientation)
  params.set('per_page', String(opts.per_page ?? 10))
  if (opts.page)        params.set('page', String(opts.page))

  const url = `${PEXELS_BASE}/search?${params.toString()}`
  const res = await fetch(url, {
    method:  'GET',
    headers: { Authorization: apiKey() },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Pexels search failed: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
  }
  const data = await res.json() as PexelsSearchResult
  logger.info('pexels_search', {
    query:        opts.query,
    orientation:  opts.orientation,
    returned:     data.photos.length,
    totalResults: data.total_results,
  })
  return data
}
''')
    print('[1/6] pexels/client.ts — created')

# ── 2. NEW: src/integrations/pexels/tools.ts ────────────────────────────────
P = ROOT / 'src/integrations/pexels/tools.ts'
if P.exists() and 'pexels_search' in P.read_text():
    print('[2/6] pexels/tools.ts already exists — skipping')
else:
    P.write_text('''// src/integrations/pexels/tools.ts
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
        }, null, 2)
      }
      default:
        return `Unknown Pexels tool: ${name}`
    }
  } catch (err) {
    return `Pexels tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
''')
    print('[2/6] pexels/tools.ts — created')

# ── 3. types.ts — add 'pexels' to IntegrationKind ───────────────────────────
P = ROOT / 'src/integrations/types.ts'
src = must_read(P)
if "'pexels'" in src:
    print('[3/6] types.ts already has pexels — skipping')
else:
    src = must_replace_once(
        src,
        "export type IntegrationKind = 'framer' | 'gsc' | 'ga4' | 'dataforseo'",
        "export type IntegrationKind = 'framer' | 'gsc' | 'ga4' | 'dataforseo' | 'pexels'",
        'types.ts IntegrationKind',
    )
    src = must_replace_once(
        src,
        "export const KNOWN_INTEGRATIONS: IntegrationKind[] = ['framer', 'gsc', 'ga4', 'dataforseo']",
        "export const KNOWN_INTEGRATIONS: IntegrationKind[] = ['framer', 'gsc', 'ga4', 'dataforseo', 'pexels']",
        'types.ts KNOWN_INTEGRATIONS',
    )
    P.write_text(src)
    print('[3/6] types.ts — added pexels')

# ── 4. integrations/index.ts — register PEXELS_TOOLS ────────────────────────
P = ROOT / 'src/integrations/index.ts'
src = must_read(P)
if 'PEXELS_TOOLS' in src:
    print('[4/6] index.ts already registers pexels — skipping')
else:
    src = must_replace_once(
        src,
        "import { DATAFORSEO_TOOLS, isDataForSeoToolName, executeDataForSeoTool } from './dataforseo/tools'",
        "import { DATAFORSEO_TOOLS, isDataForSeoToolName, executeDataForSeoTool } from './dataforseo/tools'\n"
        "import { PEXELS_TOOLS, isPexelsToolName, executePexelsTool } from './pexels/tools'",
        'index.ts imports',
    )
    src = must_replace_once(
        src,
        "  const allowed: IntegrationKind[] = ['framer', 'gsc', 'ga4', 'dataforseo']",
        "  const allowed: IntegrationKind[] = ['framer', 'gsc', 'ga4', 'dataforseo', 'pexels']",
        'index.ts tenantIntegrations allowlist',
    )
    src = must_replace_once(
        src,
        "  if (enabled.includes('dataforseo'))  tools.push(...DATAFORSEO_TOOLS)\n  return tools",
        "  if (enabled.includes('dataforseo'))  tools.push(...DATAFORSEO_TOOLS)\n"
        "  if (enabled.includes('pexels'))      tools.push(...PEXELS_TOOLS)\n"
        "  return tools",
        'index.ts buildIntegrationToolsForTenant',
    )
    src = must_replace_once(
        src,
        "export function isIntegrationToolName(name: string): boolean {\n"
        "  return isFramerToolName(name) || isGscToolName(name) || isGa4ToolName(name) || isDataForSeoToolName(name)\n"
        "}",
        "export function isIntegrationToolName(name: string): boolean {\n"
        "  return isFramerToolName(name) || isGscToolName(name) || isGa4ToolName(name) || isDataForSeoToolName(name) || isPexelsToolName(name)\n"
        "}",
        'index.ts isIntegrationToolName',
    )
    src = must_replace_once(
        src,
        "  if (isDataForSeoToolName(name))  return executeDataForSeoTool(name, input, tenant)\n"
        "  return `Unknown integration tool: ${name}`",
        "  if (isDataForSeoToolName(name))  return executeDataForSeoTool(name, input, tenant)\n"
        "  if (isPexelsToolName(name))      return executePexelsTool(name, input, tenant)\n"
        "  return `Unknown integration tool: ${name}`",
        'index.ts executeIntegrationTool',
    )
    P.write_text(src)
    print('[4/6] index.ts — registered PEXELS_TOOLS')

# ── 5. framer/client.ts — resolve & write Image field ───────────────────────
P = ROOT / 'src/integrations/framer/client.ts'
src = must_read(P)
if 'imageId' in src:
    print('[5/6] framer/client.ts already has Image field support — skipping')
else:
    # 5a. Extend BlogFieldIds interface
    src = must_replace_once(
        src,
        "export interface BlogFieldIds {\n"
        "  titleId:   string\n"
        "  dateId:    string\n"
        "  contentId: string\n"
        "}",
        "export interface BlogFieldIds {\n"
        "  titleId:   string\n"
        "  dateId:    string\n"
        "  contentId: string\n"
        "  imageId?:  string   // optional — not all Blog schemas have an Image field\n"
        "}",
        'framer/client.ts BlogFieldIds',
    )

    # 5b. Update resolveBlogFieldIds to also resolve Image (optional)
    src = must_replace_once(
        src,
        "  const titleId   = byName['Title']?.id\n"
        "  const dateId    = byName['Date']?.id\n"
        "  const contentId = byName['Content']?.id\n"
        "  if (!titleId || !dateId || !contentId) {\n"
        "    throw new Error(`Blog schema missing required field. Have: ${Object.keys(byName).join(', ')}`)\n"
        "  }\n"
        "  return { titleId, dateId, contentId }",
        "  const titleId   = byName['Title']?.id\n"
        "  const dateId    = byName['Date']?.id\n"
        "  const contentId = byName['Content']?.id\n"
        "  const imageId   = byName['Image']?.id   // optional\n"
        "  if (!titleId || !dateId || !contentId) {\n"
        "    throw new Error(`Blog schema missing required field. Have: ${Object.keys(byName).join(', ')}`)\n"
        "  }\n"
        "  return { titleId, dateId, contentId, imageId }",
        'framer/client.ts resolveBlogFieldIds',
    )

    # 5c. Update BlogPostDraft to accept imageUrl
    src = must_replace_once(
        src,
        "export interface BlogPostDraft {\n"
        "  slug:    string\n"
        "  title:   string\n"
        "  content: string             // HTML in Framer's formattedText format\n"
        "  date?:   string             // ISO 8601; defaults to now\n"
        "}",
        "export interface BlogPostDraft {\n"
        "  slug:     string\n"
        "  title:    string\n"
        "  content:  string             // HTML in Framer's formattedText format\n"
        "  date?:    string             // ISO 8601; defaults to now\n"
        "  imageUrl?: string            // external URL — Framer downloads + re-hosts\n"
        "}",
        'framer/client.ts BlogPostDraft',
    )

    # 5d. Update the addItems call to write the image field when imageUrl is given
    src = must_replace_once(
        src,
        "    const blog = await findBlog(fr)\n"
        "    const { titleId, dateId, contentId } = await resolveBlogFieldIds(blog)\n\n"
        "    await blog.addItems([{\n"
        "      slug: post.slug,\n"
        "      fieldData: {\n"
        "        [titleId]:   { type: 'string',        value: post.title },\n"
        "        [dateId]:    { type: 'date',          value: post.date ?? new Date().toISOString() },\n"
        "        [contentId]: { type: 'formattedText', value: post.content },\n"
        "      },\n"
        "    }])",
        "    const blog = await findBlog(fr)\n"
        "    const { titleId, dateId, contentId, imageId } = await resolveBlogFieldIds(blog)\n\n"
        "    const fieldData: Record<string, { type: string; value: unknown }> = {\n"
        "      [titleId]:   { type: 'string',        value: post.title },\n"
        "      [dateId]:    { type: 'date',          value: post.date ?? new Date().toISOString() },\n"
        "      [contentId]: { type: 'formattedText', value: post.content },\n"
        "    }\n"
        "    if (post.imageUrl && imageId) {\n"
        "      // Framer accepts an external URL here and downloads + re-hosts on framerusercontent.com.\n"
        "      fieldData[imageId] = { type: 'image', value: { url: post.imageUrl } }\n"
        "    }\n\n"
        "    await blog.addItems([{ slug: post.slug, fieldData }])",
        'framer/client.ts addItems call',
    )

    # 5e. createAndPublishBlogPost: pass imageUrl through to draftAndPreviewBlogPost
    # The Phase-6-added version already accepts imageUrl in its input but doesn't pass it
    # through. Patch it to forward.
    src = must_replace_once(
        src,
        "  const draft = await draftAndPreviewBlogPost(tenant, {\n"
        "    slug:    input.slug,\n"
        "    title:   input.title,\n"
        "    content: input.content,\n"
        "  })",
        "  const draft = await draftAndPreviewBlogPost(tenant, {\n"
        "    slug:     input.slug,\n"
        "    title:    input.title,\n"
        "    content:  input.content,\n"
        "    imageUrl: input.imageUrl,\n"
        "  })",
        'framer/client.ts createAndPublishBlogPost forwards imageUrl',
    )

    P.write_text(src)
    print('[5/6] framer/client.ts — added Image field support end-to-end')

# ── 6. subagent.ts — prompt updates ─────────────────────────────────────────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)
if 'pexels_search' in src:
    print('[6/6] subagent.ts already references pexels — skipping')
else:
    # Replace the "On Framer blog posts" section to include hero image + internal links + voice steps
    old_section = '''## On Framer blog posts

To propose a new blog post (RECOMMENDED — atomic create + publish, no orphan drafts):

1. Call framer_get_changed_paths first. If it shows any pending changes in the workspace, STOP — surface the situation to the operator rather than proceeding. Publishing would bundle those changes with your post.
2. Call framer_list_blog_items to confirm your proposed slug is unique and to study the existing post style and topic mix.
3. Write the post in full — title + slug + content (HTML in Framer\'s formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.).
4. File propose_action directly with:
     toolName       = "framer_create_and_publish_blog_post"
     toolInput      = { slug, title, content, imageUrl? }
     proposedAction = one-line plain-English summary for the Slack card
     priority       = P0 / P1 / P2 / P3
     previewUrl     = the post-publish URL the operator can visit after approving (https://tarino.au/blog/ followed by the slug)

On approval: the executor creates the CMS item AND publishes the site in one atomic operation. The post goes live at https://tarino.au/blog/(slug) within seconds.
On rejection: nothing is created. No cleanup needed.

Note: do NOT call framer_draft_blog_post for new posts — that\'s the legacy two-phase path. The new atomic path is cleaner because the operator approves CONTENT (not just a publish), and rejection leaves no cruft in the Blog collection.

For changes Framer\'s API can\'t do programmatically — editing existing pages, SEO meta on pages, internal linking, schema markup, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer\'s editor without further input from you. Include verbatim code blocks for schema, exact anchor text + source/target pages for linking, full revised copy for content tweaks.'''

    new_section = '''## On Framer blog posts

To propose a new blog post (atomic create + publish, no orphan drafts):

1. Call framer_get_changed_paths first. If it shows any pending changes in the workspace, STOP — surface the situation to the operator rather than proceeding. Publishing would bundle those changes with your post.

2. Call framer_list_blog_items. Two purposes:
   (a) Confirm your proposed slug is unique.
   (b) Pick 2-3 of the most recent posts and study them — they ARE the voice you should write in. Mirror cadence, paragraph length, register, and structure (how long is the intro? how often are subheads used? does the post tend to end with a CTA or a thought?). The tone is the operator\'s real voice; do not invent your own.

3. Write the post in full — title + slug + content. Content is HTML in Framer\'s formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.

4. Inside the body, embed 2-4 internal links to other Tarino posts where the cross-reference is genuinely useful (not gratuitous). Format: <a href="/blog/SLUG">descriptive anchor text</a> — use the slug from framer_list_blog_items. Anchor text should be a real noun phrase from the sentence, not "click here" or the bare title.

5. Call pexels_search with a 2-4 word CONCRETE-NOUN query that reflects the post subject — "australian small business owner laptop", "calculator paperwork desk", "warehouse logistics team". Avoid abstract phrases like "offshore hiring" (they return cliché globe-handshake stock). Pick the most editorially-relevant result. Use the "url_for_post" field from the response — that\'s the landscape-cropped URL ready to drop into Framer.

6. File propose_action with:
     toolName       = "framer_create_and_publish_blog_post"
     toolInput      = { slug, title, content, imageUrl }
     proposedAction = one-line plain-English summary for the Slack card
     priority       = P0 / P1 / P2 / P3
     previewUrl     = the post-publish URL the operator can visit after approving (https://tarino.au/blog/ followed by the slug)

On approval: executor creates the CMS item AND publishes the site atomically. The post goes live at https://tarino.au/blog/(slug) within seconds — with the chosen image and embedded internal links intact.
On rejection: nothing is created. No cleanup needed.

Note: do NOT call framer_draft_blog_post for new posts — that\'s the legacy two-phase path. The atomic path is cleaner because the operator approves CONTENT (not just a publish), and rejection leaves no cruft in the Blog collection.

For changes Framer\'s API can\'t do programmatically — editing existing pages, SEO meta on pages, internal linking inside existing posts, schema markup, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer\'s editor without further input from you. Include verbatim code blocks for schema, exact anchor text + source/target pages for linking, full revised copy for content tweaks.'''

    src = must_replace_once(src, old_section, new_section, 'subagent.ts On Framer blog posts section')

    P.write_text(src)
    print('[6/6] subagent.ts — added voice reference + hero image + internal linking steps')

print('\nDone. Run:')
print('  npx tsc --noEmit')
print('to verify, then commit + push.')
