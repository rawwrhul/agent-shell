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
      default:
        return `Unknown Framer tool: ${name}`
    }
  } catch (err) {
    return `Framer tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
