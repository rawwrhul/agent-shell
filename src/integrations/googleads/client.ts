// src/integrations/googleads/client.ts
//
// Wrapper around the Google Ads API Node client. Discipline enforced here:
//   - Every call goes through the retry wrapper (the library ships none).
//   - Every call consumes from the per-customer daily QuotaGuard.
//   - Mutations are OFF by default. mutate() throws unless the caller
//     passes an approvalId, which only the execution-path (dispatcher ->
//     executor, post-HITL-approve) possesses. Agent tool calls can never
//     reach a live account write, same discipline as the Framer executors.
//
// GAQL money fields come back in micros. Convert at the edge with
// fromMicros/toMicros re-exported from the barrel; never hand a raw micros
// value to the LLM as a dollar figure.

import { GoogleAdsApi, type Customer, type MutateOperation, services } from 'google-ads-api'
import { logger } from '../../logger'
import { resolveSharedCreds, resolveTenantConfig } from './auth'
import { withBackoff } from './retry'
import { InMemoryQuotaGuard, type QuotaGuard } from './quota'

export class TenantAdsClient {
  constructor(
    private readonly customer:   Customer,
    private readonly quota:      QuotaGuard,
    public  readonly customerId: string,
    public  readonly tenantId:   string,
  ) {}

  /** Read-only GAQL query. Auto-execute tier - safe for direct agent use. */
  async query<T = services.IGoogleAdsRow[]>(gaql: string, label = 'gaql_query'): Promise<T> {
    this.quota.consume(this.customerId)
    return withBackoff(() => this.customer.query<T>(gaql), { label: `${label}:${this.tenantId}` })
  }

  /**
   * Mutation seam - chunk 1b executors only. Requires the approvalId of a
   * resolved HITL approval; there is deliberately no way to call this from
   * the agent tool layer.
   */
  async mutate<T>(
    mutations: MutateOperation<T>[],
    opts: { approvalId: string; label?: string },
  ): Promise<services.MutateGoogleAdsResponse> {
    if (!opts?.approvalId) {
      throw new Error('google_ads mutate blocked: no approvalId. Mutations only run via the HITL execution path.')
    }
    this.quota.consume(this.customerId, mutations.length)
    logger.info('google_ads_mutate', {
      tenantId: this.tenantId, customerId: this.customerId,
      approvalId: opts.approvalId, operations: mutations.length,
    })
    return withBackoff(
      () => this.customer.mutateResources(mutations),
      { label: `${opts.label ?? 'mutate'}:${this.tenantId}` },
    )
  }
}

let _api: GoogleAdsApi | null = null
let _loginCustomerId: string | null = null
const _quota = new InMemoryQuotaGuard()
const _tenantClients = new Map<string, TenantAdsClient>()

async function api(): Promise<GoogleAdsApi> {
  if (_api) return _api
  const shared = await resolveSharedCreds()
  _loginCustomerId = shared.loginCustomerId
  _api = new GoogleAdsApi({
    client_id:       shared.clientId,
    client_secret:   shared.clientSecret,
    developer_token: shared.developerToken,
  })
  return _api
}

export async function forTenant(tenantId: string): Promise<TenantAdsClient> {
  const cached = _tenantClients.get(tenantId)
  if (cached) return cached

  const [client, tenantCfg, shared] = await Promise.all([
    api(),
    resolveTenantConfig(tenantId),
    resolveSharedCreds(),
  ])

  const customer = client.Customer({
    customer_id:       tenantCfg.customerId,
    login_customer_id: _loginCustomerId ?? shared.loginCustomerId,
    refresh_token:     shared.refreshToken,
  })

  const wrapped = new TenantAdsClient(customer, _quota, tenantCfg.customerId, tenantId)
  _tenantClients.set(tenantId, wrapped)
  return wrapped
}

/** MCC-level: list customer ids accessible to the refresh token. Used by ads:link and the smoke test. */
export async function listAccessibleCustomers(): Promise<string[]> {
  const shared = await resolveSharedCreds()
  const client = await api()
  const res = await withBackoff(
    () => client.listAccessibleCustomers(shared.refreshToken),
    { label: 'list_accessible_customers' },
  )
  return (res.resource_names ?? []).map((rn) => String(rn).replace('customers/', ''))
}
