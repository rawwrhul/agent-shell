// src/integrations/index.ts
//
// Public surface of the integrations layer:
//   1) buildIntegrationToolsForTenant(tenant) → Anthropic.Tool[] — tools the
//      subagent should see based on what's enabled for the tenant
//   2) isIntegrationToolName(name) — name predicate for the dispatch loop
//   3) executeIntegrationTool(name, input, tenant) — single entry point
//      for the subagent to call any integration tool by name
//
// To add a new integration:
//   1) Create src/integrations/<name>/{client,tools,executor?}.ts
//   2) Add the kind to IntegrationKind in types.ts
//   3) Wire its tools array and dispatcher in this file

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../tenants/types'

import { FRAMER_TOOLS, isFramerToolName, executeFramerTool } from './framer/tools'
import { GSC_TOOLS, isGscToolName, executeGscTool }         from './gsc/tools'
import { GA4_TOOLS, isGa4ToolName, executeGa4Tool }         from './ga4/tools'
import { DATAFORSEO_TOOLS, isDataForSeoToolName, executeDataForSeoTool } from './dataforseo/tools'
import { PEXELS_TOOLS, isPexelsToolName, executePexelsTool } from './pexels/tools'

import type { IntegrationKind } from './types'

export * from './types'

// ── Tool gathering ──────────────────────────────────────────────────────────

function tenantIntegrations(tenant: TenantConfig): IntegrationKind[] {
  const raw = tenant.integrations
  if (!Array.isArray(raw)) return []
  const allowed: IntegrationKind[] = ['framer', 'gsc', 'ga4', 'dataforseo', 'pexels']
  return raw.filter((x): x is IntegrationKind => allowed.includes(x as IntegrationKind))
}

export function buildIntegrationToolsForTenant(tenant: TenantConfig): Anthropic.Tool[] {
  const enabled = tenantIntegrations(tenant)
  const tools: Anthropic.Tool[] = []
  if (enabled.includes('framer'))      tools.push(...FRAMER_TOOLS)
  if (enabled.includes('gsc'))         tools.push(...GSC_TOOLS)
  if (enabled.includes('ga4'))         tools.push(...GA4_TOOLS)
  if (enabled.includes('dataforseo'))  tools.push(...DATAFORSEO_TOOLS)
  if (enabled.includes('pexels'))      tools.push(...PEXELS_TOOLS)
  return tools
}

// ── Tool dispatch ───────────────────────────────────────────────────────────

export function isIntegrationToolName(name: string): boolean {
  return isFramerToolName(name) || isGscToolName(name) || isGa4ToolName(name) || isDataForSeoToolName(name) || isPexelsToolName(name)
}

export async function executeIntegrationTool(
  name:    string,
  input:   Record<string, unknown>,
  tenant:  TenantConfig,
): Promise<string> {
  if (isFramerToolName(name))      return executeFramerTool(name, input, tenant)
  if (isGscToolName(name))         return executeGscTool(name, input, tenant)
  if (isGa4ToolName(name))         return executeGa4Tool(name, input, tenant)
  if (isDataForSeoToolName(name))  return executeDataForSeoTool(name, input, tenant)
  if (isPexelsToolName(name))      return executePexelsTool(name, input, tenant)
  return `Unknown integration tool: ${name}`
}
