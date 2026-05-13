// src/integrations/index.ts
// Integration tool stubs for external platforms (Framer, GSC, GA4, DataForSEO).
// These are READ-only tools used by specialists to gather data before
// proposing changes via propose_action. Actual writes to external systems
// go through the execution worker post-approval.
//
// Phase 1: stubs that return "not configured" so the agent knows to use
// web_fetch or run_command instead. Full implementations land as each
// integration is wired up.

import Anthropic from '@anthropic-ai/sdk'
import { TenantConfig } from '../tenants/types'
import { logger } from '../logger'

// ── Types ─────────────────────────────────────────────────────────────────

export interface IntegrationToolContext {
  tenant: TenantConfig
}

// ── Tool definitions ──────────────────────────────────────────────────────

const INTEGRATION_TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'analyze_page',
    description: 'Fetch and analyze an SEO-relevant page. Returns HTTP status, title, meta description, headings, canonical, schema blocks, OG tags, image alt coverage, internal/external link counts, and word count. Use instead of multiple web_fetch + run_command calls.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Absolute URL of the page to analyze.' },
      },
      required: ['url'],
    },
  },
]

const INTEGRATION_TOOL_NAMES = new Set(INTEGRATION_TOOL_DEFS.map(t => t.name))

export function buildIntegrationToolsForTenant(_tenant: TenantConfig): Anthropic.Tool[] {
  return INTEGRATION_TOOL_DEFS
}

export function isIntegrationToolName(name: string): boolean {
  return INTEGRATION_TOOL_NAMES.has(name)
}

export async function executeIntegrationTool(
  name: string,
  input: Record<string, unknown>,
  tenant: TenantConfig,
): Promise<string> {
  logger.info('integration_tool_call', { tool: name, tenantId: tenant.tenantId })

  switch (name) {
    case 'analyze_page': {
      const url = String(input.url ?? '')
      if (!url) return 'analyze_page: url is required'
      return analyzePage(url)
    }
    default:
      return `Integration tool not implemented: ${name}`
  }
}

// ── analyze_page implementation ───────────────────────────────────────────

async function analyzePage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CGS-Agent/3.0 SEO-Analyzer' },
      signal: AbortSignal.timeout(15_000),
    })

    const html = await res.text()
    const status = res.status

    const title       = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
    const metaDesc    = extractMeta(html, 'description')
    const canonical   = extractAttr(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    const h1s         = extractAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi)
    const h2s         = extractAll(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi)
    const ogTitle     = extractMeta(html, 'og:title')
    const ogDesc      = extractMeta(html, 'og:description')

    const imgTags     = [...html.matchAll(/<img[^>]*>/gi)]
    const imgsWithAlt = imgTags.filter(m => /alt=["'][^"']+["']/i.test(m[0])).length
    const altCoverage = imgTags.length ? `${imgsWithAlt}/${imgTags.length}` : 'no images'

    const internalLinks = [...html.matchAll(/href=["'](?:\/[^"']*|https?:\/\/[^"']*)['"]/gi)].length
    const wordCount     = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length

    const schemaBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .map(m => m[1].trim().slice(0, 200))

    const lines = [
      `HTTP status: ${status}`,
      `Title: ${title || '(missing)'}`,
      `Meta description: ${metaDesc || '(missing)'}`,
      `Canonical: ${canonical || '(missing)'}`,
      `H1s (${h1s.length}): ${h1s.slice(0, 3).map(h => h.slice(0, 80)).join(' | ') || '(none)'}`,
      `H2s (${h2s.length}): ${h2s.slice(0, 5).map(h => h.slice(0, 60)).join(' | ') || '(none)'}`,
      `OG title: ${ogTitle || '(missing)'}`,
      `OG description: ${ogDesc || '(missing)'}`,
      `Image alt coverage: ${altCoverage}`,
      `Internal link count (approx): ${internalLinks}`,
      `Word count (approx): ${wordCount}`,
      `Schema blocks (${schemaBlocks.length}): ${schemaBlocks.slice(0, 2).join('\n---\n') || '(none)'}`,
    ]

    return lines.join('\n')
  } catch (err) {
    return `analyze_page error: ${String(err).slice(0, 200)}`
  }
}

function extractTag(html: string, re: RegExp): string {
  const m = html.match(re)
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : ''
}

function extractMeta(html: string, name: string): string {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i')
  const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i')
  const m = html.match(re) ?? html.match(alt)
  return m ? m[1].trim() : ''
}

function extractAttr(html: string, re: RegExp): string {
  const m = html.match(re)
  return m ? m[1].trim() : ''
}

function extractAll(html: string, re: RegExp): string[] {
  const results: string[] = []
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(html)) !== null) {
    results.push(m[1].replace(/<[^>]+>/g, '').trim())
  }
  return results
}
