#!/usr/bin/env tsx
// Usage: npm run onboard
//
// Onboards a new client end-to-end: Slack secrets → tenant row (with the
// runtime columns the shell actually reads: target domain, competitors,
// timezone, brief, operator) → integrations config → tenant_schedules rows
// (registered as live BullMQ repeatables immediately — no restart needed
// for schedules).
//
// What it does NOT cover: per-skill credentials (npm run onboard:creds).
import * as rl from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import 'dotenv/config'
import { registerTenant, setTenantIntegrationConfig } from '../tenants/registry'
import { AgentType } from '../tenants/types'
import { upsertSchedule } from '../scheduler'
import type { RunKind } from '../scheduler/types'
import { config } from '../config'

const secrets = new SecretManagerServiceClient()
const io = rl.createInterface({ input, output })

const ALLOWED_INTEGRATIONS = ['framer', 'gsc', 'ga4', 'dataforseo', 'pexels']

async function ask(q: string, fallback?: string): Promise<string> {
  const answer = (await io.question(q)).trim()
  return answer || (fallback ?? '')
}

async function main() {
  console.log('\n══════════════════════════════════════════════\n  CGS Agent Shell — Client Onboarding\n══════════════════════════════════════════════\n')

  const clientName = await ask('Client name (e.g. "Acme Corp"): ')
  const tenantId   = await ask('Tenant slug (lowercase, hyphens only, e.g. "acme-corp"): ')
  const billingTag = await ask(`Billing tag (default: ${tenantId}-seo): `, `${tenantId}-seo`)

  console.log('\nAgent types: seo-auditor | seo-loop | content-writer | data-analyst | researcher | general | quoting')
  const agentType  = (await ask('Agent type: ')) as AgentType

  const skillsRaw  = await ask('Skills (comma-separated, e.g. "seo-auditor,brand-voice"): ')
  const skills     = skillsRaw.split(',').map(s => s.trim()).filter(Boolean)

  console.log('\n── Client context (what the agents actually run against) ─────────')
  const targetDomain      = await ask('Target domain (e.g. https://acme.com): ')
  const competitorsRaw    = await ask('Competitor domains (comma-separated, blank to skip): ')
  const competitorDomains = competitorsRaw.split(',').map(s => s.trim()).filter(Boolean)
  const cronTimezone      = await ask('Timezone (default: Australia/Sydney): ', 'Australia/Sydney')
  const businessBrief     = await ask('One-paragraph business brief (blank to add later): ')
  const operatorSlackId   = await ask('Operator Slack user ID (U..., blank to skip): ')

  console.log('\n── Slack ──────────────────────────────────────────────────────────\nCreate a Slack app in the client workspace first (see deployment guide).\n')
  const slackBotToken      = await ask('Slack Bot Token (xoxb-...): ')
  const slackAppToken      = await ask('Slack App Token (xapp-...): ')
  const slackSigningSecret = await ask('Slack Signing Secret: ')
  const slackChannelId     = await ask('Slack Channel ID (C...): ')

  console.log(`\n── Integrations ───────────────────────────────────────────────────\nAvailable: ${ALLOWED_INTEGRATIONS.join(' | ')}`)
  const integrationsRaw = await ask('Enable (comma-separated, e.g. "framer,gsc,ga4,dataforseo"): ')
  const integrations = integrationsRaw.split(',').map(s => s.trim()).filter(Boolean)
  const invalid = integrations.filter(i => !ALLOWED_INTEGRATIONS.includes(i))
  if (invalid.length) {
    console.error(`\n❌ Unknown integrations: ${invalid.join(', ')}. Allowed: ${ALLOWED_INTEGRATIONS.join(', ')}`)
    process.exit(1)
  }
  const gscSiteUrl       = integrations.includes('gsc')    ? await ask('GSC site URL (sc-domain:acme.com or https://acme.com/): ') : ''
  const ga4PropertyId    = integrations.includes('ga4')    ? await ask('GA4 property ID (numeric): ') : ''
  const framerProjectUrl = integrations.includes('framer') ? await ask('Framer project URL: ') : ''

  console.log('\n── Schedules ──────────────────────────────────────────────────────\nStagger minutes per client to avoid all tenants firing in the same minute.')
  const dailyCron = await ask("Daily run cron (default: '0 8 * * 1,3,5' — 8am Mon/Wed/Fri): ", '0 8 * * 1,3,5')
  const auditCron = await ask("SEO audit cron (default: '0 0 * * 6' — midnight Saturday): ", '0 0 * * 6')

  io.close()

  console.log('\n📦 Storing Slack secrets in GCP Secret Manager…')
  const secretMap = {
    [`${tenantId}-slack-bot-token`]:      slackBotToken,
    [`${tenantId}-slack-app-token`]:      slackAppToken,
    [`${tenantId}-slack-signing-secret`]: slackSigningSecret,
  }
  for (const [id, val] of Object.entries(secretMap)) {
    await storeSecret(id, val)
    console.log(`  ✅ ${id}`)
  }

  console.log('\n📝 Registering tenant in database…')
  await registerTenant({
    tenantId, clientName, agentType, slackChannelId, billingTag, skills,
    targetDomain:        targetDomain || undefined,
    competitorDomains:   competitorDomains.length ? competitorDomains : undefined,
    cronTimezone,
    businessBrief:       businessBrief || undefined,
    operatorSlackUserId: operatorSlackId || undefined,
  })

  if (integrations.length) {
    console.log('\n🔌 Writing integrations config…')
    await setTenantIntegrationConfig({
      tenantId, integrations,
      gscSiteUrl:       gscSiteUrl || undefined,
      ga4PropertyId:    ga4PropertyId || undefined,
      framerProjectUrl: framerProjectUrl || undefined,
    })
  }

  console.log('\n⏰ Seeding schedules (live immediately — no restart needed)…')
  const wanted: Array<{ runKind: RunKind; cronExpr: string }> = [
    { runKind: 'daily',     cronExpr: dailyCron },
    { runKind: 'seo_audit', cronExpr: auditCron },
  ]
  if (integrations.includes('gsc') || integrations.includes('ga4')) {
    // Before the daily runs so agents see fresh history. Stagger-safe:
    // pure data job, no LLM contention.
    wanted.push({ runKind: 'metrics_sync', cronExpr: '30 5 * * *' })
  }
  for (const s of wanted) {
    try {
      await upsertSchedule({ tenantId, runKind: s.runKind, cronExpr: s.cronExpr, timezone: cronTimezone })
      console.log(`  ✅ ${s.runKind} → ${s.cronExpr} (${cronTimezone})`)
    } catch (err) {
      console.error(`  ❌ ${s.runKind} failed: ${String(err).slice(0, 200)}`)
      console.error('     If this is a CHECK constraint error, the tenant_schedules run_kind constraint needs that kind added.')
    }
  }

  console.log(`
══════════════════════════════════════════════
  ✅ ${clientName} onboarded!
══════════════════════════════════════════════

Tenant ID:     ${tenantId}
Agent type:    ${agentType}
Skills:        ${skills.join(', ') || '(none)'}
Integrations:  ${integrations.join(', ') || '(none)'}
Schedules:     daily ${dailyCron} | seo_audit ${auditCron} (${cronTimezone})

Next steps:
  1. Add client tool credentials:
     npm run onboard:creds ${tenantId}

  2. Verify:
     npm run creds:check ${tenantId}

  3. Restart the shell so the tenant bot starts:
     push to main (Cloud Build redeploys) or restart the Cloud Run service

  4. In their Slack workspace: /invite @<bot-name>

  5. Test: @<bot-name> run a quick test task — then check the trace in Langfuse
`)
  process.exit(0)
}

async function storeSecret(id: string, value: string) {
  const parent = `projects/${config.GCP_PROJECT_ID}`
  const name   = `${parent}/secrets/${id}`
  try { await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } }) }
  catch { await secrets.createSecret({ parent, secretId: id, secret: { replication: { automatic: {} } } }); await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } }) }
}

main().catch(err => { console.error('Onboarding failed:', err); process.exit(1) })
