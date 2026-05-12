// src/integrations/ga4/tools.ts
//
// GA4 agent tools. Read-only — no executor for GA4.

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import * as ga4 from './client'

export const GA4_TOOLS: Anthropic.Tool[] = [
  {
    name: 'ga4_run_report',
    description:
      'Run a custom Google Analytics 4 report with arbitrary dimensions and metrics. ' +
      'Useful for: identifying high-conversion pages, traffic sources by channel, mobile vs desktop performance, search engine breakdown. ' +
      'For common analyses, prefer the simpler ga4_top_pages or ga4_traffic_sources tools.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate:  { type: 'string', description: 'YYYY-MM-DD or "28daysAgo" or "yesterday"' },
        endDate:    { type: 'string', description: 'YYYY-MM-DD or "yesterday"' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'GA4 dimension names. Common: pagePath, pageTitle, sessionSourceMedium, deviceCategory, country, date.' },
        metrics:    { type: 'array', items: { type: 'string' }, description: 'GA4 metric names. Common: screenPageViews, totalUsers, sessions, engagementRate, averageSessionDuration, conversions, totalRevenue.' },
        limit:      { type: 'integer', description: 'Max rows (default 100)' },
      },
      required: ['startDate', 'endDate', 'dimensions', 'metrics'],
    },
  },
  {
    name: 'ga4_top_pages',
    description: 'Get the top pages by views over the date range, with engagement metrics. Convenience wrapper around ga4_run_report.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD or "28daysAgo" (default)' },
        endDate:   { type: 'string', description: 'YYYY-MM-DD or "yesterday" (default)' },
        limit:     { type: 'integer', description: 'Max pages (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'ga4_traffic_sources',
    description: 'Get traffic source breakdown (source / medium / channel). Convenience wrapper around ga4_run_report.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD or "28daysAgo" (default)' },
        endDate:   { type: 'string', description: 'YYYY-MM-DD or "yesterday" (default)' },
        limit:     { type: 'integer', description: 'Max sources (default 20)' },
      },
      required: [],
    },
  },
]

const GA4_TOOL_NAMES = new Set(GA4_TOOLS.map(t => t.name))

export function isGa4ToolName(name: string): boolean {
  return GA4_TOOL_NAMES.has(name)
}

export async function executeGa4Tool(
  name:    string,
  input:   Record<string, unknown>,
  tenant:  TenantConfig,
): Promise<string> {
  try {
    switch (name) {
      case 'ga4_run_report': {
        const i = input as unknown as ga4.RunReportArgs
        if (!i.startDate || !i.endDate || !i.dimensions?.length || !i.metrics?.length) {
          return 'ga4_run_report error: startDate, endDate, dimensions (non-empty), and metrics (non-empty) are required'
        }
        const r = await ga4.runReport(tenant, i)
        return JSON.stringify(r, null, 2)
      }
      case 'ga4_top_pages': {
        const i = input as { startDate?: string; endDate?: string; limit?: number }
        const r = await ga4.runReport(tenant, {
          startDate:  i.startDate ?? '28daysAgo',
          endDate:    i.endDate   ?? 'yesterday',
          dimensions: ['pagePath', 'pageTitle'],
          metrics:    ['screenPageViews', 'totalUsers', 'engagementRate', 'averageSessionDuration'],
          limit:      i.limit ?? 20,
          orderBys:   [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        })
        return JSON.stringify(r, null, 2)
      }
      case 'ga4_traffic_sources': {
        const i = input as { startDate?: string; endDate?: string; limit?: number }
        const r = await ga4.runReport(tenant, {
          startDate:  i.startDate ?? '28daysAgo',
          endDate:    i.endDate   ?? 'yesterday',
          dimensions: ['sessionSourceMedium', 'sessionDefaultChannelGroup'],
          metrics:    ['sessions', 'totalUsers', 'engagementRate', 'conversions'],
          limit:      i.limit ?? 20,
          orderBys:   [{ metric: { metricName: 'sessions' }, desc: true }],
        })
        return JSON.stringify(r, null, 2)
      }
      default:
        return `Unknown GA4 tool: ${name}`
    }
  } catch (err) {
    return `GA4 tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
