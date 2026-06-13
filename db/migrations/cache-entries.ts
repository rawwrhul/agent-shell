// db/migrations/cache-entries.ts
//
// Phase 3 mini-cache (scoped-down rollout 5). Protects unit-metered vendor
// APIs (Ahrefs charges per row returned, 50-unit minimum per request) from
// agent loops re-asking the same questions across runs and tenants.
//
// Scope decisions carried from the roadmap:
//   - tenant-scoped by default ('' tenant_id = shared, NOT used yet)
//   - lazy eviction (expired rows deleted opportunistically on write),
//     no nightly sweep until the full CachedClient rollout
//   - visibility tagging deferred until a sharing use case exists

import { Pool } from 'pg'

export async function runCacheEntriesMigration(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      source      TEXT NOT NULL,
      cache_key   TEXT NOT NULL,
      tenant_id   TEXT NOT NULL DEFAULT '',
      payload     JSONB NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (source, cache_key, tenant_id)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cache_entries_expiry ON cache_entries (expires_at)`)
  console.log('  cache-entries: vendor API cache ready')
}
