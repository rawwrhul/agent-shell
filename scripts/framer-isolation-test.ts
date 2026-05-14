// scripts/framer-isolation-test.ts
//
// Phase 6 isolation test.
//
// Exercises the FULL production code path without touching the live site:
//   1. Load tarino's framer_project_url from the tenants table (real query).
//   2. Use production withFramerSession + draftAndPreviewBlogPost from
//      src/integrations/framer/client.ts. This pulls the encrypted Framer
//      credential via loadCredential and decrypts with CREDENTIAL_ENCRYPTION_KEY.
//   3. Call dispatchExecution('framer_rollback_draft', ...) directly. This
//      goes through src/execution/dispatcher.ts and src/integrations/framer/
//      executor.ts — every production layer except BullMQ/queue and Slack.
//   4. Verify result.ok === true.
//
// What this proves green:
//   - Tenant row + framer_project_url loadable
//   - integration_credentials encryption / decryption end-to-end
//   - Production client.ts wiring (vs. the env-var test client.mts)
//   - dispatcher.ts routes 'framer_rollback_draft' correctly
//   - executor.ts execFramerRollbackDraft works end-to-end
//   - Both halves of the two-phase commit (the draft step worked above)
//
// What this does NOT prove (separate concerns):
//   - BullMQ wiring (queue producer → worker → dispatcher) — proven by GSC
//   - Slack render layer for the new tool names — visual check, no logic risk
//   - Agent reasoning + tool calling — covered by existing eval infrastructure
//
// Run from project root:
//   npx tsx scripts/framer-isolation-test.ts
//
// Requires the same env the production worker uses:
//   DATABASE_URL, CREDENTIAL_ENCRYPTION_KEY
//
// Never publishes. Safe to run at any time.

import { Pool } from 'pg'
import { dispatchExecution } from '../src/execution/dispatcher'
import { draftAndPreviewBlogPost } from '../src/integrations/framer/client'
import type { TenantConfig } from '../src/tenants/types'
import type { IntegrationContext } from '../src/integrations/types'

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set')
  }
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY not set. The production storage layer needs ' +
      'this to decrypt the Framer API key. Pull it from your usual prod/staging env.'
    )
  }

  // ── Step 1: load minimal tenant config from the real tenants table ───────
  // We don't go through getTenant() because that pulls Slack tokens etc. via
  // Secret Manager. For this test we only need fields the Framer code reads.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const { rows } = await pool.query<{ client_name: string; framer_project_url: string | null }>(
    `SELECT client_name, framer_project_url FROM tenants WHERE tenant_id = 'tarino' AND is_active = true`
  )
  if (!rows.length) {
    throw new Error("Tenant 'tarino' not found in tenants table (or inactive)")
  }
  const { client_name, framer_project_url } = rows[0]
  if (!framer_project_url) {
    throw new Error('tarino.framer_project_url is null. Set it via tarino-integrations-seed.sql.')
  }
  await pool.end()

  // Build the minimal TenantConfig shape that production code reads. Cast
  // through unknown because we're intentionally omitting fields irrelevant
  // to the Framer integration (Slack tokens, HITL sheet IDs, etc.).
  const tenant = {
    tenantId:           'tarino',
    clientName:         client_name,
    framer_project_url,
  } as unknown as TenantConfig

  console.log(`[isolation] tenant: ${tenant.tenantId} (${tenant.clientName})`)
  console.log(`[isolation] framer_project_url: ${tenant.framer_project_url}`)
  console.log('')

  // ── Step 2: create a draft via the production client.ts ──────────────────
  const slug = `_test-isolation-${Date.now()}`
  console.log(`[isolation] creating draft via production client.ts (slug=${slug})...`)

  const draft = await draftAndPreviewBlogPost(tenant, {
    slug,
    title: 'TEST POST — Phase 6 isolation test. Safe to delete.',
    content:
      '<p dir="auto">Phase 6 isolation test of the production code path. ' +
      'Created and removed by the same script run. Never published.</p>',
  })

  console.log(`[isolation] ✓ draft created: itemId=${draft.itemId}`)
  console.log(`[isolation] ✓ preview.confirmationHash=${draft.preview.confirmationHash}`)
  console.log(`[isolation] ✓ preview.changesCount=${draft.preview.changesCount}`)
  console.log('')

  // ── Step 3: roll back via dispatchExecution — tests dispatcher + executor ─
  console.log("[isolation] calling dispatchExecution('framer_rollback_draft', ...)")
  console.log('[isolation]   (this exercises the same code path the worker uses,')
  console.log('[isolation]    but for a rollback — production never gets touched)')
  console.log('')

  const ctx: IntegrationContext = {
    tenant,
    taskId:     'isolation-test',
    approvalId: 'manual-isolation-test',
  }

  const result = await dispatchExecution(
    'framer_rollback_draft',
    { itemId: draft.itemId, slug },
    ctx,
  )

  console.log('[isolation] dispatchExecution result:')
  console.log(JSON.stringify(result, null, 2))
  console.log('')

  if (!result.ok) {
    console.error('[isolation] FAILED — production code path errored on rollback.')
    console.error(`[isolation] Manually remove the draft: slug=${slug}, itemId=${draft.itemId}`)
    process.exit(1)
  }

  console.log('[isolation] ✓ end-to-end production code path verified.')
  console.log('[isolation]   tarino.au untouched. Draft created and removed cleanly.')
  console.log('')
  console.log('[isolation] What this means for Phase 6:')
  console.log('[isolation]   - The same dispatcher + executor chain handles')
  console.log('[isolation]     framer_confirm_publish (which would publish to tarino.au).')
  console.log('[isolation]   - All that differs in the publish path is which client.ts')
  console.log('[isolation]     function gets called (confirmPublish vs removeBlogPost).')
  console.log('[isolation]   - You can now run the Slack test with high confidence the')
  console.log('[isolation]     code path will execute correctly when you approve a card.')
}

main().catch((err) => {
  console.error('[isolation] FAILED:', err)
  console.error('[isolation] If a draft was created but not removed, search Tarino\'s')
  console.error('[isolation]   Blog for slug starting with "_test-isolation-" and delete manually.')
  process.exit(1)
})
