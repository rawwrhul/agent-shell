export type AgentType =
  | 'seo-auditor'
  | 'content-writer'
  | 'data-analyst'
  | 'researcher'
  | 'general'

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
  googleSaEmail:      string
  googlePrivateKey:   string
  // Agent
  agentType:          AgentType
  agentModel:         string
  tokenBudgetPerRun:  number
  skills:             string[]
  billingTag:         string
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
  billing_tag:                  string
  is_active:                    boolean
  secret_slack_bot_token:       string
  secret_slack_app_token:       string
  secret_slack_signing_secret:  string
  secret_hitl_spreadsheet_id:   string
  secret_google_sa_email:       string
  secret_google_private_key:    string
  created_at:                   Date
  updated_at:                   Date
}
