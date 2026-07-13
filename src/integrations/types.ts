// src/integrations/types.ts
//
// Shared types for the integrations layer.

import type { TenantConfig } from '../tenants/types'

/** Identifier for integration kinds. New integrations get added here. */
export type IntegrationKind = 'framer' | 'webflow' | 'gsc' | 'ga4' | 'dataforseo' | 'pexels' | 'ahrefs' | 'surfer' | 'googleads'

export const KNOWN_INTEGRATIONS: IntegrationKind[] = ['framer', 'webflow', 'gsc', 'ga4', 'dataforseo', 'pexels', 'ahrefs', 'surfer', 'googleads']

/** Context passed to every integration handler / executor. */
export interface IntegrationContext {
  tenant:      TenantConfig
  taskId:      string
  approvalId?: string         // present for execution-path calls; absent for direct agent tool calls
  runId?:      string
}

/** Result of an execution-path call (i.e. an approved action being shipped). */
export interface ExecutionResult {
  ok:      boolean
  summary: string             // short human-readable line, written to execution_jobs.result.summary
  detail?: Record<string, unknown>   // structured data (deployment IDs, URLs, counts, etc.)
  error?:  string             // populated when ok === false
}
