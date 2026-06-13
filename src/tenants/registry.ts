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
  tenantId:       string
  clientName:     string
  agentType:      AgentType
  slackChannelId: string
  billingTag:     string
  skills:         string[]
  agentModel?:    string
  tokenBudget?:   number
  // Onboarding-fix additions — runtime columns from later migrations that
  // the old CLI never populated (tenants used to come up blind):
  targetDomain?:        string
  competitorDomains?:   string[]
  cronTimezone?:        string
  businessBrief?:       string
  operatorSlackUserId?: string
  cmsPathPrefixes?:     string[]
}): Promise<void> {
  await pool.query(
    `INSERT INTO tenants (
      tenant_id, client_name, agent_type, agent_model, token_budget_per_run,
      skills, slack_channel_id, billing_tag, is_active,
      secret_slack_bot_token, secret_slack_app_token, secret_slack_signing_secret,
      target_domain, competitor_domains, cron_timezone,
      business_brief, operator_slack_user_id, cms_path_prefixes,
      created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())`,
    [
      params.tenantId,
      params.clientName,
      params.agentType,
      params.agentModel ?? config.AGENT_MODEL,
      params.tokenBudget ?? config.TOKEN_BUDGET_PER_RUN,
      JSON.stringify(params.skills),
      params.slackChannelId,
      params.billingTag,
      `${params.tenantId}-slack-bot-token`,
      `${params.tenantId}-slack-app-token`,
      `${params.tenantId}-slack-signing-secret`,
      params.targetDomain ?? null,
      params.competitorDomains ?? null,
      params.cronTimezone ?? 'Australia/Sydney',
      params.businessBrief ?? null,
      params.operatorSlackUserId ?? null,
      params.cmsPathPrefixes ?? null,
    ]
  )
  logger.info('tenant_registered', { tenantId: params.tenantId, client: params.clientName })
}

/**
 * Write the integrations array + per-integration config columns. Separate
 * from registerTenant because these columns come from the hand-run
 * sql/20260512-integrations-and-executions.sql rather than the db:migrate
 * chain — on an environment that never ran it, this UPDATE fails with a
 * clear hint instead of breaking base registration.
 */
export async function setTenantIntegrationConfig(params: {
  tenantId:          string
  integrations:      string[]
  gscSiteUrl?:       string
  ga4PropertyId?:    string
  framerProjectUrl?: string
}): Promise<void> {
  try {
    await pool.query(
      `UPDATE tenants
          SET integrations       = $2::jsonb,
              gsc_site_url       = $3,
              ga4_property_id    = $4,
              framer_project_url = $5,
              updated_at         = NOW()
        WHERE tenant_id = $1`,
      [
        params.tenantId,
        JSON.stringify(params.integrations),
        params.gscSiteUrl ?? null,
        params.ga4PropertyId ?? null,
        params.framerProjectUrl ?? null,
      ],
    )
    logger.info('tenant_integrations_set', { tenantId: params.tenantId, integrations: params.integrations })
  } catch (err) {
    logger.error('tenant_integrations_set_failed', {
      tenantId: params.tenantId, err: String(err).slice(0, 200),
      hint: 'If columns are missing, run sql/20260512-integrations-and-executions.sql in the Supabase SQL editor first, then re-run: npm run onboard:integrations',
    })
    throw err
  }
}

export function invalidateCache(tenantId: string) {
  cache.delete(tenantId)
}

// ── Secret resolution ─────────────────────────────────────────────────────────

async function resolve(row: TenantRow): Promise<TenantConfig> {
  const [bot, app, sig] = await Promise.all([
    getSecret(row.secret_slack_bot_token),
    getSecret(row.secret_slack_app_token),
    getSecret(row.secret_slack_signing_secret),
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
    cmsPathPrefixes:           row.cms_path_prefixes ?? undefined,
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
