import { Pool } from 'pg'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { TenantConfig, TenantRow, AgentType } from './types'
import { config } from '../config'
import { logger } from '../logger'

const pool    = new Pool({ connectionString: config.DATABASE_URL })
const secrets = new SecretManagerServiceClient()

// 5-minute in-memory cache — avoids Secret Manager calls on every task
const cache = new Map<string, { cfg: TenantConfig; exp: number }>()
const TTL   = 5 * 60 * 1000

export async function getTenant(tenantId: string): Promise<TenantConfig> {
  const hit = cache.get(tenantId)
  if (hit && hit.exp > Date.now()) return hit.cfg

  const res = await pool.query<TenantRow>(
    'SELECT * FROM tenants WHERE tenant_id = $1 AND is_active = true',
    [tenantId]
  )
  if (!res.rows.length) throw new Error(`Tenant '${tenantId}' not found or inactive`)

  const cfg = await resolve(res.rows[0])
  cache.set(tenantId, { cfg, exp: Date.now() + TTL })
  return cfg
}

export async function listActiveTenants(): Promise<TenantRow[]> {
  const res = await pool.query<TenantRow>(
    'SELECT * FROM tenants WHERE is_active = true ORDER BY client_name'
  )
  return res.rows
}

export async function registerTenant(params: {
  tenantId:      string
  clientName:    string
  agentType:     AgentType
  slackChannelId: string
  hitlSheetName?: string
  billingTag:    string
  skills:        string[]
  agentModel?:   string
  tokenBudget?:  number
}): Promise<void> {
  await pool.query(
    `INSERT INTO tenants (
      tenant_id, client_name, agent_type, agent_model, token_budget_per_run,
      skills, slack_channel_id, hitl_sheet_name, billing_tag, is_active,
      secret_slack_bot_token, secret_slack_app_token, secret_slack_signing_secret,
      secret_hitl_spreadsheet_id, secret_google_sa_email, secret_google_private_key,
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13,$14,$15,NOW(),NOW())`,
    [
      params.tenantId,
      params.clientName,
      params.agentType,
      params.agentModel ?? config.AGENT_MODEL,
      params.tokenBudget ?? config.TOKEN_BUDGET_PER_RUN,
      JSON.stringify(params.skills),
      params.slackChannelId,
      params.hitlSheetName ?? 'Approvals',
      params.billingTag,
      `${params.tenantId}-slack-bot-token`,
      `${params.tenantId}-slack-app-token`,
      `${params.tenantId}-slack-signing-secret`,
      `${params.tenantId}-hitl-spreadsheet-id`,
      `${params.tenantId}-google-sa-email`,
      `${params.tenantId}-google-private-key`,
    ]
  )
  logger.info('tenant_registered', { tenantId: params.tenantId, client: params.clientName })
}

export function invalidateCache(tenantId: string) {
  cache.delete(tenantId)
}

// ── Secret resolution ─────────────────────────────────────────────────────────

async function resolve(row: TenantRow): Promise<TenantConfig> {
  const [bot, app, sig, sheet, saEmail, saKey] = await Promise.all([
    getSecret(row.secret_slack_bot_token),
    getSecret(row.secret_slack_app_token),
    getSecret(row.secret_slack_signing_secret),
    getSecret(row.secret_hitl_spreadsheet_id),
    getSecret(row.secret_google_sa_email),
    getSecret(row.secret_google_private_key),
  ])

  return {
    tenantId:           row.tenant_id,
    clientName:         row.client_name,
    createdAt:          row.created_at,
    isActive:           row.is_active,
    slackBotToken:      bot,
    slackAppToken:      app,
    slackSigningSecret: sig,
    slackChannelId:     row.slack_channel_id,
    hitlSpreadsheetId:  sheet,
    hitlSheetName:      row.hitl_sheet_name,
    googleSaEmail:      saEmail,
    googlePrivateKey:   saKey,
    agentType:          row.agent_type,
    agentModel:         row.agent_model,
    tokenBudgetPerRun:  row.token_budget_per_run,
    skills:             Array.isArray(row.skills) ? row.skills : JSON.parse(row.skills as unknown as string),
    billingTag:         row.billing_tag,
    integrations:       row.integrations ?? [],
    gsc_site_url:       row.gsc_site_url ?? undefined,
    ga4_property_id:    row.ga4_property_id ?? undefined,
    framer_project_url: row.framer_project_url ?? undefined,
    // R3 / SEO-5 fields previously missing from the resolver — added for
    // discovery skills that read tenant.targetDomain / competitorDomains /
    // disabledOpportunityTypes.
    targetDomain:              row.target_domain ?? undefined,
    competitorDomains:         row.competitor_domains ?? undefined,
    disabledOpportunityTypes:  row.disabled_opportunity_types ?? undefined,
    cronTimezone:              row.cron_timezone ?? undefined,
    businessBrief:             row.business_brief ?? undefined,
    operatorSlackUserId:       row.operator_slack_user_id ?? undefined,
  }
}

async function getSecret(id: string): Promise<string> {
  const name = `projects/${config.GCP_PROJECT_ID}/secrets/${id}/versions/latest`
  try {
    const [v] = await secrets.accessSecretVersion({ name })
    return v.payload?.data?.toString() ?? ''
  } catch (err) {
    logger.error('secret_not_found', { id, err: String(err) })
    throw new Error(`Secret '${id}' not found in Secret Manager`)
  }
}
