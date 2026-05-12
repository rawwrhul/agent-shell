// src/integrations/gsc/tools.ts
//
// Anthropic tool definitions for Google Search Console.
// All read tools surface directly. Writes (sitemap submit) go through propose_action.

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import * as gsc from './client'

export const GSC_TOOLS: Anthropic.Tool[] = [
  {
    name: 'gsc_query_search_analytics',
    description:
      'Query Google Search Console performance data for this tenant\'s site. Returns clicks, impressions, click-through-rate, and average position broken down by the dimensions you request (query / page / country / device / date). ' +
      'USE THIS to ground every priority call: which pages get traffic, which queries drive it, which rankings to defend, which gaps to close. ' +
      'Without this data the agent is guessing — with it, priorities become math.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate:  { type: 'string', description: 'YYYY-MM-DD (typically 28 days ago for trend analysis)' },
        endDate:    { type: 'string', description: 'YYYY-MM-DD (typically yesterday)' },
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: ['query', 'page', 'country', 'device', 'searchAppearance', 'date'] },
          description: 'One or more dimensions. Most useful combos: ["page"] for page-level totals; ["query"] for keyword discovery; ["page","query"] for which keywords each page ranks on.',
        },
        rowLimit:   { type: 'integer', description: 'Max rows to return (default 100, max 25000)' },
      },
      required: ['startDate', 'endDate', 'dimensions'],
    },
  },
  {
    name: 'gsc_inspect_url',
    description:
      'Inspect a specific URL in Google Search Console: index status, last crawl time, canonical Google chose, mobile usability, rich results coverage. ' +
      'USE THIS when investigating why a specific page is not appearing in search results or behaving unexpectedly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL to inspect (must be on the verified GSC property)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'gsc_list_sitemaps',
    description: 'List all sitemaps Google knows about for this site, with last submission time, indexed counts, errors, warnings.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

const GSC_TOOL_NAMES = new Set(GSC_TOOLS.map(t => t.name))

export function isGscToolName(name: string): boolean {
  return GSC_TOOL_NAMES.has(name)
}

export async function executeGscTool(
  name:    string,
  input:   Record<string, unknown>,
  tenant:  TenantConfig,
): Promise<string> {
  try {
    switch (name) {
      case 'gsc_query_search_analytics': {
        const i = input as {
          startDate:  string
          endDate:    string
          dimensions: Array<'query'|'page'|'country'|'device'|'searchAppearance'|'date'>
          rowLimit?:  number
        }
        if (!i.startDate || !i.endDate || !i.dimensions?.length) {
          return 'gsc_query_search_analytics error: startDate, endDate, and dimensions (non-empty) are required'
        }
        const rows = await gsc.querySearchAnalytics(tenant, i)
        return JSON.stringify({ rowCount: rows.length, rows: rows.slice(0, 200) }, null, 2)
      }
      case 'gsc_inspect_url': {
        const i = input as { url: string }
        if (!i.url) return 'gsc_inspect_url error: url is required'
        const result = await gsc.inspectUrl(tenant, i.url)
        return JSON.stringify(result, null, 2)
      }
      case 'gsc_list_sitemaps': {
        const result = await gsc.listSitemaps(tenant)
        return JSON.stringify(result, null, 2)
      }
      default:
        return `Unknown GSC tool: ${name}`
    }
  } catch (err) {
    return `GSC tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
