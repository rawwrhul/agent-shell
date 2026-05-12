// src/integrations/ga4/client.ts
//
// Google Analytics 4 Data API client.
//
// Auth: Application Default Credentials. Cloud Run service account must be
// granted "Viewer" on each tenant's GA4 property (Admin → Property Access
// Management → Add user → paste service account email).
//
// Required APIs enabled on GCP project: Google Analytics Data API
// (analyticsdata.googleapis.com).

import { BetaAnalyticsDataClient } from '@google-analytics/data'
import type { TenantConfig } from '../../tenants/types'

let _client: BetaAnalyticsDataClient | null = null

function getClient(): BetaAnalyticsDataClient {
  if (_client) return _client
  // ADC resolves from runtime — no explicit credentials needed.
  _client = new BetaAnalyticsDataClient()
  return _client
}

function propertyId(tenant: TenantConfig): string {
  if (!tenant.ga4_property_id) {
    throw new Error(`Tenant ${tenant.tenantId}: ga4_property_id not set in tenants table`)
  }
  // Property ID is the numeric ID, not the measurement ID (G-XXXXXXX).
  // Format used by the API: "properties/123456789"
  if (tenant.ga4_property_id.startsWith('properties/')) return tenant.ga4_property_id
  return `properties/${tenant.ga4_property_id}`
}

// ── Operations ──────────────────────────────────────────────────────────────

export interface GA4Row {
  dimensionValues: string[]
  metricValues:    Array<number | string>
}

export interface RunReportArgs {
  startDate:  string                       // 'YYYY-MM-DD' or '28daysAgo'
  endDate:    string                       // 'YYYY-MM-DD' or 'yesterday'
  dimensions: string[]                     // e.g. ['pagePath', 'sessionSourceMedium']
  metrics:    string[]                     // e.g. ['screenPageViews', 'totalUsers', 'engagementRate']
  limit?:     number
  orderBys?:  unknown[]
  dimensionFilter?: unknown
}

export interface RunReportResult {
  rows:           GA4Row[]
  rowCount:       number
  metricHeaders:  Array<{ name: string; type: string }>
  dimensionHeaders: Array<{ name: string }>
}

export async function runReport(tenant: TenantConfig, args: RunReportArgs): Promise<RunReportResult> {
  const client = getClient()
  const [res] = await client.runReport({
    property:    propertyId(tenant),
    dateRanges:  [{ startDate: args.startDate, endDate: args.endDate }],
    dimensions:  args.dimensions.map(name => ({ name })),
    metrics:     args.metrics.map(name => ({ name })),
    limit:       args.limit ?? 100,
    orderBys:    args.orderBys as never,
    dimensionFilter: args.dimensionFilter as never,
  })

  return {
    rowCount: res.rowCount ?? 0,
    rows: (res.rows ?? []).map(row => ({
      dimensionValues: (row.dimensionValues ?? []).map(d => d.value ?? ''),
      metricValues:    (row.metricValues    ?? []).map(m => {
        const v = m.value ?? ''
        const n = Number(v)
        return Number.isFinite(n) ? n : v
      }),
    })),
    metricHeaders:    (res.metricHeaders    ?? []).map(h => ({ name: h.name ?? '', type: String(h.type ?? '') })),
    dimensionHeaders: (res.dimensionHeaders ?? []).map(h => ({ name: h.name ?? '' })),
  }
}
