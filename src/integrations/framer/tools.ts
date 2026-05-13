// src/integrations/framer/tools.ts
//
// Anthropic tool definitions for Framer.
//
// Read tools surface directly — agent can call them without HITL.
// Write tools (update_page_seo, publish, deploy, create_cms_item, update_cms_item)
// DO NOT appear in this tool list. The agent proposes them via `propose_action`
// from the SEO skill, which files an approval. The execution worker is what
// actually invokes Framer for writes.

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import * as fr from './client'

export const FRAMER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'framer_get_project_info',
    description:
      'Get high-level info about the Framer project for this tenant (name, project URL, breakpoints, status). ' +
      'Useful as a first call when you need orientation on what the site looks like before drafting changes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'framer_list_pages',
    description:
      'List every page in the Framer project (page ID, path, name). Use this to discover what pages exist before proposing per-page changes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'framer_get_page_seo',
    description:
      'Get the current SEO settings for a specific Framer page: title, description, Open Graph fields, robots directive. ' +
      'Use this to see what is currently set BEFORE proposing a change — otherwise you may propose the same thing that is already there.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pageId: { type: 'string', description: 'Framer page ID from framer_list_pages' },
      },
      required: ['pageId'],
    },
  },
  {
    name: 'framer_get_changed_paths',
    description:
      'List paths that have unpublished changes (added / modified / removed). Useful to confirm whether other team members have unpublished work pending before you propose changes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'framer_get_page_content',
    description:
      'Read the current body content of a page (headings, paragraphs, images, sections). ' +
      'Use this for daily-generation pillar 2 (internal linking) and pillar 3 (additive copy) to see what is already on the page before drafting an addition. ' +
      'For just SEO meta-fields, use framer_get_page_seo instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slugOrPageId: { type: 'string', description: 'Slug like "/about" or page ID from framer_list_pages' },
      },
      required: ['slugOrPageId'],
    },
  },
  {
    name: 'framer_create_draft_page',
    description:
      'Create a NEW page in Framer as a draft (not published). Returns pageId and previewUrl. ' +
      'Used for daily-generation pillar 1 (new pages). After creating the draft, pass the returned previewUrl ' +
      'through to propose_action so the Slack approval card shows a clickable preview link the operator can review before approving. ' +
      'If the workspace plan does not support native drafts (Basic plan), the tool falls back to creating the page as live but with noindex set; the preview URL is the live URL, Google will not index it, and approving the propose_action removes the noindex.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug:            { type: 'string', description: 'URL slug like "/seasonal-workers-australia"' },
        title:           { type: 'string', description: 'Page title (shown in browser tab and search results)' },
        metaDescription: { type: 'string', description: 'Meta description shown in search results' },
        contentBlocks: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of content blocks. Each block has type ("heading","paragraph","image","list","section",...) and content fields. Order matters — first block is at top of page.',
        },
      },
      required: ['slug', 'title', 'contentBlocks'],
    },
  },
  {
    name: 'framer_update_page_draft',
    description:
      'Push a draft revision of an EXISTING page. Returns the previewUrl for the updated page. ' +
      'Used for daily-generation pillar 2 (internal links) and pillar 3 (additive copy / meta). ' +
      'ADDITIONS ONLY — never use this to replace or remove existing content. ' +
      'The change is queued as a Framer draft; it does not go live until the operator approves the propose_action you file afterward.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pageId: { type: 'string', description: 'Page ID from framer_list_pages' },
        additions: {
          type: 'object',
          description: 'Object describing what to add: { afterSection: "hero", blocks: [{...}] } or { metaDescriptionAppend: "..." } or { internalLinks: [{ anchor, target, placement }] }. Shape is loose; describe placement and content.',
        },
      },
      required: ['pageId', 'additions'],
    },
  },
  {
    name: 'framer_get_preview_url',
    description:
      'Get the preview URL for a Framer page (staging URL for drafts, live URL for noindex-fallback). ' +
      'Most callers do not need this — framer_create_draft_page and framer_update_page_draft return previewUrl directly. Use this only to re-resolve a URL later.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pageId: { type: 'string' },
      },
      required: ['pageId'],
    },
  },
]

const FRAMER_TOOL_NAMES = new Set(FRAMER_TOOLS.map(t => t.name))

export function isFramerToolName(name: string): boolean {
  return FRAMER_TOOL_NAMES.has(name)
}

export async function executeFramerTool(
  name:    string,
  input:   Record<string, unknown>,
  tenant:  TenantConfig,
): Promise<string> {
  try {
    switch (name) {
      case 'framer_get_project_info': {
        const info = await fr.getProjectInfo(tenant)
        return JSON.stringify(info, null, 2)
      }
      case 'framer_list_pages': {
        const pages = await fr.listPages(tenant)
        return JSON.stringify(pages, null, 2)
      }
      case 'framer_get_page_seo': {
        const i = input as { pageId: string }
        if (!i.pageId) return 'framer_get_page_seo error: pageId is required'
        const seo = await fr.getPageSeo(tenant, i.pageId)
        return JSON.stringify(seo, null, 2)
      }
      case 'framer_get_changed_paths': {
        const changes = await fr.getChangedPaths(tenant)
        return JSON.stringify(changes, null, 2)
      }
      case 'framer_get_page_content': {
        const i = input as { slugOrPageId: string }
        if (!i.slugOrPageId) return 'framer_get_page_content error: slugOrPageId is required'
        const page = await fr.getPageContent(tenant, i.slugOrPageId)
        return JSON.stringify(page, null, 2)
      }
      case 'framer_create_draft_page': {
        const i = input as {
          slug: string; title: string; metaDescription?: string
          contentBlocks: Array<Record<string, unknown>>
        }
        if (!i.slug || !i.title || !Array.isArray(i.contentBlocks)) {
          return 'framer_create_draft_page error: slug, title, and contentBlocks are required'
        }
        const result = await fr.createDraftPage(tenant, {
          slug: i.slug, title: i.title,
          metaDescription: i.metaDescription,
          contentBlocks: i.contentBlocks,
        })
        return JSON.stringify({
          pageId:     result.pageId,
          previewUrl: result.previewUrl,
          mode:       result.mode,
          note:       result.mode === 'noindex_fallback'
            ? 'Native drafts unavailable on this workspace plan; page created as live-but-noindex. Pass previewUrl through to propose_action — operator can preview at this URL, and approving will remove the noindex directive.'
            : 'Draft created. Pass previewUrl through to propose_action so the operator can preview before approving.',
        }, null, 2)
      }
      case 'framer_update_page_draft': {
        const i = input as { pageId: string; additions: Record<string, unknown> }
        if (!i.pageId || !i.additions) {
          return 'framer_update_page_draft error: pageId and additions are required'
        }
        const result = await fr.updatePageDraft(tenant, {
          pageId: i.pageId, additions: i.additions,
        })
        return JSON.stringify({
          pageId:     result.pageId,
          previewUrl: result.previewUrl,
          note:       'Draft revision pushed. Pass previewUrl through to propose_action so the operator can preview before approving.',
        }, null, 2)
      }
      case 'framer_get_preview_url': {
        const i = input as { pageId: string }
        if (!i.pageId) return 'framer_get_preview_url error: pageId is required'
        const previewUrl = await fr.getPreviewUrl(tenant, i.pageId)
        return JSON.stringify({ pageId: i.pageId, previewUrl }, null, 2)
      }
      default:
        return `Unknown Framer tool: ${name}`
    }
  } catch (err) {
    return `Framer tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
