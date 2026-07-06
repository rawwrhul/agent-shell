// src/integrations/googleads/auth.ts
//
// Credential resolution for Google Ads, wired to the existing Secret
// Manager resolver (src/credentials/resolver.ts). Shared creds are resolved
// once per process and cached; the resolver itself adds a 10 minute TTL.

import { getSharedCredential, getClientCredential } from '../../credentials/resolver'
import {
  SHARED_CRED_KEYS,
  TENANT_CUSTOMER_ID_KEY,
  normalizeCid,
  type SharedGoogleAdsCreds,
  type TenantGoogleAdsConfig,
} from './types'

let _shared: SharedGoogleAdsCreds | null = null

export async function resolveSharedCreds(): Promise<SharedGoogleAdsCreds> {
  if (_shared) return _shared

  const [developerToken, clientId, clientSecret, refreshToken, loginCustomerId] = await Promise.all([
    getSharedCredential(SHARED_CRED_KEYS.developerToken),
    getSharedCredential(SHARED_CRED_KEYS.clientId),
    getSharedCredential(SHARED_CRED_KEYS.clientSecret),
    getSharedCredential(SHARED_CRED_KEYS.refreshToken),
    getSharedCredential(SHARED_CRED_KEYS.loginCustomerId),
  ])

  const missing: string[] = []
  if (!developerToken)  missing.push(SHARED_CRED_KEYS.developerToken)
  if (!clientId)        missing.push(SHARED_CRED_KEYS.clientId)
  if (!clientSecret)    missing.push(SHARED_CRED_KEYS.clientSecret)
  if (!refreshToken)    missing.push(SHARED_CRED_KEYS.refreshToken)
  if (!loginCustomerId) missing.push(SHARED_CRED_KEYS.loginCustomerId)
  if (missing.length) {
    throw new Error(`Google Ads shared credentials missing: ${missing.join(', ')}. Run: npm run setup:cgs`)
  }

  _shared = {
    developerToken:  developerToken!,
    clientId:        clientId!,
    clientSecret:    clientSecret!,
    refreshToken:    refreshToken!,
    loginCustomerId: normalizeCid(loginCustomerId!),
  }
  return _shared
}

export async function resolveTenantConfig(tenantId: string): Promise<TenantGoogleAdsConfig> {
  const cid = await getClientCredential(tenantId, TENANT_CUSTOMER_ID_KEY)
  if (!cid) {
    throw new Error(
      `Google Ads customer id not configured for tenant "${tenantId}". Run: npm run ads:link ${tenantId} <customer-id>`,
    )
  }
  return { customerId: normalizeCid(cid) }
}

/** Test seam. */
export function _resetSharedCredsCache(): void {
  _shared = null
}
