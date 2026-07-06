export type CredentialOwner = 'cgs' | 'client'

export interface CredentialDef {
  key:         string
  label:       string
  owner:       CredentialOwner
  required:    boolean
  description: string
  howToGet:    string
}

export const CGS_CREDENTIALS: CredentialDef[] = [
  { key: 'ahrefs_api_key',    label: 'Ahrefs API Key',    owner: 'cgs', required: false, description: 'Backlink analysis, domain authority, keyword research', howToGet: 'Ahrefs → Account → API → Generate key' },
  { key: 'surfer_api_key',    label: 'Surfer API Key',    owner: 'cgs', required: false, description: 'Content guidelines and scoring from SERP analysis', howToGet: 'Surfer → requires Custom Plan or API Add-on — contact Surfer support' },
  { key: 'semrush_api_key',   label: 'SEMrush API Key',   owner: 'cgs', required: false, description: 'Keyword research, competitor analysis, site audits',   howToGet: 'SEMrush → Profile → API → Get API key' },
  { key: 'brave_api_key',     label: 'Brave Search API Key', owner: 'cgs', required: false, description: 'Web search for all agents', howToGet: 'brave.com/search/api → Subscribe → Copy API key' },
  { key: 'dataforseo_login',  label: 'DataForSEO Login',  owner: 'cgs', required: false, description: 'SERP data, keyword difficulty, search volume', howToGet: 'DataForSEO dashboard → API access' },
  { key: 'dataforseo_password', label: 'DataForSEO Password', owner: 'cgs', required: false, description: 'DataForSEO API password', howToGet: 'DataForSEO dashboard → API access' },
  { key: 'voyage_api_key',    label: 'Voyage API Key',    owner: 'cgs', required: false, description: 'High-quality embeddings for pgvector semantic memory', howToGet: 'dash.voyageai.com → API keys' },
  { key: 'assemblyai_api_key', label: 'AssemblyAI API Key', owner: 'cgs', required: false, description: 'Voice-note transcription for the quoting agent (AU English + trade vocab)', howToGet: 'assemblyai.com → Dashboard → API key' },
  { key: 'google_ads_developer_token',   label: 'Google Ads Developer Token',    owner: 'cgs', required: false, description: 'API access token from the CGS MCC',                          howToGet: 'ads.google.com (MCC) → Tools → API Center → Developer token' },
  { key: 'google_ads_client_id',         label: 'Google Ads OAuth Client ID',    owner: 'cgs', required: false, description: 'OAuth Desktop-app client in the CGS GCP project',           howToGet: 'console.cloud.google.com → APIs & Services → Credentials → OAuth client ID (Desktop app)' },
  { key: 'google_ads_client_secret',     label: 'Google Ads OAuth Client Secret', owner: 'cgs', required: false, description: 'Secret paired with the OAuth client id',                   howToGet: 'Same OAuth client → client secret' },
  { key: 'google_ads_refresh_token',     label: 'Google Ads Refresh Token',      owner: 'cgs', required: false, description: 'Minted once via consent flow as an MCC-access user. Publish the consent screen to Production or the token expires in 7 days', howToGet: 'One-time OAuth consent flow with scope https://www.googleapis.com/auth/adwords' },
  { key: 'google_ads_login_customer_id', label: 'Google Ads MCC ID',             owner: 'cgs', required: false, description: 'CGS manager account id, digits only',                       howToGet: 'ads.google.com (MCC) → account id top right, strip dashes' },
]

export const AGENT_CREDENTIAL_MANIFESTS: Record<string, CredentialDef[]> = {
  'seo-auditor': [
    { key: 'target_domain',             label: 'Target Domain',                    owner: 'client', required: true,  description: 'Primary domain to audit',                                    howToGet: 'e.g. https://acme.com' },
    { key: 'gsc_site_url',              label: 'Google Search Console Site URL',   owner: 'client', required: true,  description: 'GSC property URL for this client',                           howToGet: 'GSC → select property → copy URL shown at top' },
    { key: 'competitor_domains',        label: 'Competitor Domains (comma-sep)',   owner: 'client', required: false, description: 'Domains for competitor analysis',                            howToGet: 'e.g. https://competitor1.com,https://competitor2.com' },
    { key: 'pagespeed_api_key',         label: 'PageSpeed Insights API Key',       owner: 'client', required: false, description: 'Core Web Vitals checks at higher rate limits',               howToGet: 'console.cloud.google.com → PageSpeed Insights API → Credentials' },
    { key: 'ga4_property_id',           label: 'GA4 Property ID',                 owner: 'client', required: false, description: 'Correlate SEO traffic with conversions',                     howToGet: 'GA4 → Admin → Property details → Property ID' },
    { key: 'cms_api_url',               label: 'CMS API URL (optional)',           owner: 'client', required: false, description: 'Allows agent to update meta tags directly — always requires approval', howToGet: 'WordPress: /wp-json/wp/v2 | Contentful: api.contentful.com' },
    { key: 'cms_api_key',               label: 'CMS API Key (optional)',           owner: 'client', required: false, description: 'CMS write access — all writes need human approval',          howToGet: 'WordPress: Users → Application Passwords | Contentful: Settings → API keys' },
  ],
  'content-writer': [
    { key: 'target_domain',    label: 'Target Domain',   owner: 'client', required: true,  description: 'Site content is written for',          howToGet: 'e.g. https://acme.com' },
    { key: 'cms_api_url',      label: 'CMS API URL',     owner: 'client', required: true,  description: 'Where to draft or publish content',    howToGet: 'WordPress: /wp-json/wp/v2 | Contentful: api.contentful.com' },
    { key: 'cms_api_key',      label: 'CMS API Key',     owner: 'client', required: true,  description: 'All publishes require human approval', howToGet: 'WordPress: Users → Application Passwords' },
    { key: 'brand_voice_url',  label: 'Brand Voice Doc', owner: 'client', required: false, description: 'URL to brand guidelines doc',          howToGet: 'Share a Google Doc publicly or via service account' },
  ],
  'data-analyst': [
    { key: 'ga4_property_id',   label: 'GA4 Property ID',            owner: 'client', required: true,  description: 'Primary traffic data source',              howToGet: 'GA4 → Admin → Property details → Property ID' },
    { key: 'bq_project_id',     label: 'BigQuery Project ID (opt)',  owner: 'client', required: false, description: 'Advanced analysis via GA4 BigQuery exports', howToGet: 'GCP Console → project selector → Project ID' },
  ],
  'general': [
    { key: 'target_domain', label: 'Target Domain (optional)', owner: 'client', required: false, description: 'Primary domain for web tasks', howToGet: 'e.g. https://acme.com' },
  ],
  'quoting': [
    { key: 'electrician_email', label: 'Electrician Delivery Email', owner: 'client', required: true,  description: 'Where the approved quote PDF is emailed (the electrician, not the customer, in MVP)', howToGet: 'The electrician’s working inbox' },
  ],
}
