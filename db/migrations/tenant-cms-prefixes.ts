// db/migrations/tenant-cms-prefixes.ts
//
// Phase 2, unit 3 (discovery accuracy): per-tenant CMS/blog path prefixes.
//
// Used to classify a target URL as a CMS item (automatable) vs a marketing
// page (operator-executed) when deriving an opportunity's execution_mode.
// Nullable; the site root is always treated as non-CMS regardless. Idempotent.

import type { Pool } from 'pg'

export async function runTenantCmsPrefixesMigration(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS cms_path_prefixes TEXT[]
  `)
}
