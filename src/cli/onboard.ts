#!/usr/bin/env tsx
// Usage: npm run onboard
import * as rl from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import 'dotenv/config'
import { registerTenant } from '../tenants/registry'
import { ensureHeaders }  from '../hitl/sheets'
import { getTenant }      from '../tenants/registry'
import { AgentType }      from '../tenants/types'
import { config }         from '../config'

const secrets = new SecretManagerServiceClient()
const io = rl.createInterface({ input, output })

async function main() {
  console.log('\n══════════════════════════════════════════════\n  CGS Agent Shell — Client Onboarding\n══════════════════════════════════════════════\n')

  const clientName  = await io.question('Client name (e.g. "Acme Corp"): ')
  const tenantId    = await io.question('Tenant slug (lowercase, hyphens only, e.g. "acme-corp"): ')
  const billingTag  = await io.question(`Billing tag (e.g. "${tenantId}-seo"): `)

  console.log('\nAgent types: seo-auditor | content-writer | data-analyst | researcher | general')
  const agentType   = await io.question('Agent type: ') as AgentType

  const skillsRaw   = await io.question('Skills (comma-separated, e.g. "seo-auditor,brand-voice"): ')
  const skills      = skillsRaw.split(',').map(s => s.trim()).filter(Boolean)

  console.log('\n── Slack ────────────────────────────────────────────────\nCreate a Slack app in the client\'s workspace (see guide).\n')
  const slackBotToken      = await io.question('Slack Bot Token (xoxb-...): ')
  const slackAppToken      = await io.question('Slack App Token (xapp-...): ')
  const slackSigningSecret = await io.question('Slack Signing Secret: ')
  const slackChannelId     = await io.question('Slack Channel ID (C...): ')

  console.log('\n── Google Sheets ────────────────────────────────────────\n')
  const googleSaEmail  = await io.question('Google Service Account Email: ')
  const googlePrivKey  = await io.question('Google Private Key (paste full key, press Enter twice when done): ')
  const spreadsheetId  = await io.question('Google Sheet ID (from URL): ')
  const sheetName      = (await io.question('Sheet tab name (default: Approvals): ')) || 'Approvals'

  io.close()

  console.log('\n📦 Storing secrets in GCP Secret Manager…')
  const secretMap = {
    [`${tenantId}-slack-bot-token`]:       slackBotToken,
    [`${tenantId}-slack-app-token`]:       slackAppToken,
    [`${tenantId}-slack-signing-secret`]:  slackSigningSecret,
    [`${tenantId}-hitl-spreadsheet-id`]:   spreadsheetId,
    [`${tenantId}-google-sa-email`]:       googleSaEmail,
    [`${tenantId}-google-private-key`]:    googlePrivKey,
  }

  for (const [id, val] of Object.entries(secretMap)) {
    await storeSecret(id, val)
    console.log(`  ✅ ${id}`)
  }

  console.log('\n📝 Registering tenant in database…')
  await registerTenant({ tenantId, clientName, agentType, slackChannelId, hitlSheetName: sheetName, billingTag, skills })

  console.log('\n📊 Setting up Google Sheet headers…')
  const tenant = await getTenant(tenantId)
  await ensureHeaders(tenant)

  console.log(`
══════════════════════════════════════════════
  ✅ ${clientName} onboarded!
══════════════════════════════════════════════

Tenant ID:  ${tenantId}
Agent type: ${agentType}
Skills:     ${skills.join(', ')}

Next steps:
  1. Add client-specific credentials:
     npm run onboard:creds ${tenantId}

  2. Restart the shell — their bot starts automatically:
     npm run dev

  3. In their Slack workspace: /invite @<bot-name>

  4. Test: @<bot-name> run a quick test task
`)
}

async function storeSecret(id: string, value: string) {
  const parent = `projects/${config.GCP_PROJECT_ID}`
  const name   = `${parent}/secrets/${id}`
  try { await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } }) }
  catch { await secrets.createSecret({ parent, secretId: id, secret: { replication: { automatic: {} } } }); await secrets.addSecretVersion({ parent: name, payload: { data: Buffer.from(value) } }) }
}

main().catch(err => { console.error('Onboarding failed:', err); process.exit(1) })
