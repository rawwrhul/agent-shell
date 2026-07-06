// src/integrations/googleads/types.ts
//
// Shared types for the Google Ads integration.
//
// Auth model (MCC pattern): CGS owns one manager account (MCC). All shared
// credentials (developer token, OAuth client, refresh token, MCC id) are
// CGS-level secrets stored once via setup:cgs. Each tenant contributes only
// its own customer id (CID), stored per-tenant via ads:link. Every API call
// authenticates as login_customer_id = MCC, customer_id = tenant CID.
//
// Secret naming (resolver prepends the owner prefix):
//   cgs-google_ads_developer_token
//   cgs-google_ads_client_id
//   cgs-google_ads_client_secret
//   cgs-google_ads_refresh_token
//   cgs-google_ads_login_customer_id
//   {tenantId}-google_ads_customer_id
//
// Customer-facing language: all changes run through the official Google Ads
// API. Never reference the client package name or version in anything a
// client might see.

export interface SharedGoogleAdsCreds {
  developerToken:  string
  clientId:        string
  clientSecret:    string
  refreshToken:    string
  /** CGS MCC id, digits only. */
  loginCustomerId: string
}

export interface TenantGoogleAdsConfig {
  /** Tenant client account CID, digits only. */
  customerId: string
}

/** Per-tenant credential key (resolver prepends `{tenantId}-`). */
export const TENANT_CUSTOMER_ID_KEY = 'google_ads_customer_id'

/** CGS shared credential keys (resolver prepends `cgs-`). */
export const SHARED_CRED_KEYS = {
  developerToken:  'google_ads_developer_token',
  clientId:        'google_ads_client_id',
  clientSecret:    'google_ads_client_secret',
  refreshToken:    'google_ads_refresh_token',
  loginCustomerId: 'google_ads_login_customer_id',
} as const

/**
 * Normalise a customer id to the digits-only form the API requires.
 * Accepts '123-456-7890', '1234567890', ' 123 456 7890 '.
 * Throws on anything that does not reduce to exactly 10 digits.
 */
export function normalizeCid(raw: string): string {
  const digits = String(raw).replace(/[^0-9]/g, '')
  if (digits.length !== 10) {
    throw new Error(`Invalid Google Ads customer id "${raw}" - expected 10 digits, got ${digits.length}`)
  }
  return digits
}
