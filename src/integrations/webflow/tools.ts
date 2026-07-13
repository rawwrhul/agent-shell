// src/integrations/webflow/tools.ts
//
// Read-side Webflow tools (auto-execute tier) for agent reasoning — the
// Webflow mirror of framer/tools.ts. Writes go through propose_action →
// executors, never through here.

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import * as wf from './client'

export const WEBFLOW_TOOLS: Anthropic.Tool[] = [
  {
    name: 'webflow_get_site_info',
    description: 'Webflow site overview: display name, custom domains, last publish time. Use to confirm the site is reachable and when it last went live.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'webflow_list_blog_items',
    description: 'List blog CMS items (id, slug, title, draft/published state, last published). Use before pitching a post (check what exists), before internal linking (find target slugs), and to map the editorial range.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max items (default 100)' },
      },
    },
  },
  {
    name: 'webflow_get_blog_item',
    description: 'Fetch one blog item by slug, including its full field data (title, body HTML, image, meta description). Use before proposing any edit to a post — never edit a page you have not read.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Item slug (without path prefix)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'webflow_list_pages',
    description: 'List static (non-CMS) pages with their paths and titles — the service/marketing pages. Use to find pagePath values for meta or text edits.',
    input_schema: { type: 'object', properties: {} },
  },
]

export function isWebflowToolName(name: string): boolean {
  return name.startsWith('webflow_') && !name.startsWith('webflow_confirm') // confirm_publish is an executor, not a read tool
}

export async function executeWebflowTool(
  name:   string,
  input:  Record<string, unknown>,
  tenant: TenantConfig,
): Promise<string> {
  try {
    switch (name) {
      case 'webflow_get_site_info': {
        const info = await wf.getSiteInfo(tenant)
        return JSON.stringify(info, null, 2)
      }
      case 'webflow_list_blog_items': {
        const limit = Math.min(Number(input.limit) || 100, 100)
        const map = await wf.resolveBlogFields(tenant)
        const items = await wf.listBlogItems(tenant, limit)
        return JSON.stringify({
          collectionSlug: map.collectionSlug,
          count: items.length,
          items: items.map(i => ({
            id: i.id,
            slug: String(i.fieldData[map.slugField] ?? ''),
            title: String(i.fieldData[map.titleField] ?? ''),
            isDraft: i.isDraft,
            lastPublished: i.lastPublished,
          })),
        }, null, 2)
      }
      case 'webflow_get_blog_item': {
        const slug = String(input.slug ?? '').trim()
        if (!slug) return 'webflow_get_blog_item error: slug is required'
        const item = await wf.getItemBySlug(tenant, slug)
        if (!item) return `webflow_get_blog_item: no item with slug '${slug}'`
        return JSON.stringify({ id: item.id, isDraft: item.isDraft, lastPublished: item.lastPublished, fieldData: item.fieldData }, null, 2)
      }
      case 'webflow_list_pages': {
        const pages = await wf.listPages(tenant)
        return JSON.stringify({ count: pages.length, pages }, null, 2)
      }
      default:
        return `Unknown Webflow tool: ${name}`
    }
  } catch (err) {
    return `${name} error: ${String(err).slice(0, 400)}`
  }
}
