// db/migrations/sheets-removal.ts
//
// The Google Sheets HITL audit mirror was removed (2026-06-12). PG +
// Slack has been the authoritative approval store since R3.1; the sheet
// was a best-effort write-only mirror nobody read. New tenants no longer
// get per-tenant Google SA credentials, so the three secret-name columns
// must accept NULL. Existing rows keep their values (harmless, ignored).
// Idempotent: DROP NOT NULL is a no-op when already nullable.

import { Pool } from 'pg'

export async function runSheetsRemovalMigration(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE tenants ALTER COLUMN secret_hitl_spreadsheet_id DROP NOT NULL`)
  await pool.query(`ALTER TABLE tenants ALTER COLUMN secret_google_sa_email     DROP NOT NULL`)
  await pool.query(`ALTER TABLE tenants ALTER COLUMN secret_google_private_key  DROP NOT NULL`)
  console.log('  sheets-removal: tenant google-credential columns now nullable')
}
