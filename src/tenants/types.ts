// src/tenants/types.ts
//
// Tenant config types. R3 additions are all OPTIONAL so the existing
// registry.ts that maps DB rows to TenantConfig doesn't need a forced
// rewrite — the loader can add the new fields incrementally.

export type AgentType =
  | 'seo-auditor'
  | 'content-writer'
  | 'data-analyst'
  | 'researcher'
  | 'general'
  | 'seo-loop'                       // R3

export interface TenantConfig {
  tenantId:           string
  clientName:         string
  createdAt:          Date
  isActive:           boolean

  // Slack
  slackBotToken:      string
  slackAppToken:      string
  slackSigningSecret: string
  slackChannelId:     string

  // HITL
  hitlSpreadsheetId:  string
  hitlSheetName:      string
  hitlSheetGid?:      number              // R3
  googleSaEmail:      string
  googlePrivateKey:   string

  // Agent
  agentType:          AgentType
  agentModel:         string
  tokenBudgetPerRun:  number
  skills:             string[]
  billingTag:         string

  // ── R3 additions (ALL OPTIONAL so existing loader doesn't need updating) ──

  /**
   * Canonical target domain for SEO work (e.g. "tarino.au"). When the SEO
   * skill is loaded, this is injected into every specialist's system prompt.
   * If null/undefined, SEO specialists halt and surface a config opportunity.
   */
  targetDomain?:      string | null

  /** Optional list of competitor domains. Used by competitor analyst. */
  competitorDomains?: string[]

  /** Per-tenant cron timezone override. Default Australia/Sydney. */
  cronTimezone?:      string
}

export interface TenantRow {
  tenant_id:                    string
  client_name:                  string
  agent_type:                   AgentType
  agent_model:                  string
  token_budget_per_run:         number
  skills:                       string[]
  slack_channel_id:             string
  hitl_sheet_name:              string
  hitl_sheet_gid:               number | null   // R3
  billing_tag:                  string
  is_active:                    boolean
  target_domain:                string | null   // R3
  competitor_domains:           string[] | null // R3
  cron_timezone:                string | null   // R3
  secret_slack_bot_token:       string
  secret_slack_app_token:       string
  secret_slack_signing_secret:  string
  secret_hitl_spreadsheet_id:   string
  secret_google_sa_email:       string
  secret_google_private_key:    string
  created_at:                   Date
  updated_at:                   Date
}
