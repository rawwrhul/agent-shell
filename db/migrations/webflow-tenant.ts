// db/migrations/webflow-tenant.ts
//
// Webflow CMS support: per-tenant site id (non-secret; the site token lives
// encrypted in integration_credentials under integration='webflow').
// Idempotent.

import type { Pool } from 'pg'

export async function runWebflowTenantMigration(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS webflow_site_id TEXT
  `)
  console.log('  webflow-tenant: webflow_site_id column ready')
}
