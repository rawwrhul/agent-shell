// src/memory/store.ts
//
// Read/write layer for tenant_memory (L2) and run_scratchpad (L1).
//
// Design notes:
// - tenant_memory is upsert-on-(tenant_id, type, key). Re-recording the
//   same fact bumps evidenceCount and confidence rather than creating a
//   duplicate row. This is what makes the agent compound across runs.
// - run_scratchpad is append-only. Keys can be reused; readers get all
//   matching rows in insertion order.
// - Both stores expect a `Pool` from `pg` — same connection style as
//   src/core/slack/state-store.ts from Rollout 1.

import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import type {
  MemoryEntry,
  MemoryInput,
  MemoryQuery,
  MemoryType,
  ScratchpadEntry,
  ScratchpadInput,
} from './types';

// ── tenant_memory (L2) ──────────────────────────────────────────────

/**
 * Insert a new memory or merge with an existing one matching
 * (tenant_id, type, key). On merge: bumps evidenceCount, raises
 * confidence asymptotically toward 1.0, replaces value with the new
 * version, updates source_run_id.
 *
 * Returns the resulting row.
 */
export async function recordMemory(
  pool: Pool,
  input: MemoryInput
): Promise<MemoryEntry> {
  const id = randomUUID();
  const startConfidence = clamp01(input.confidence ?? 0.5);

  // Upsert on (tenant_id, type, key) unique index.
  // On conflict: keep the existing id/created_at, update value/source/confidence.
  // Confidence on corroboration: c' = c + (1 - c) * 0.3  (asymptotic toward 1).
  const sql = `
    INSERT INTO tenant_memory
      (id, tenant_id, type, key, value, confidence, evidence_count, source_run_id, created_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, 1, $7, NOW(), NOW())
    ON CONFLICT (tenant_id, type, key)
    DO UPDATE SET
      value = EXCLUDED.value,
      confidence = LEAST(1.0, tenant_memory.confidence + (1.0 - tenant_memory.confidence) * 0.3),
      evidence_count = tenant_memory.evidence_count + 1,
      source_run_id = EXCLUDED.source_run_id,
      updated_at = NOW()
    RETURNING *
  `;
  const params = [
    id,
    input.tenantId,
    input.type,
    input.key,
    input.value,
    startConfidence,
    input.sourceRunId ?? null,
  ];
  const { rows } = await pool.query(sql, params);
  return rowToMemory(rows[0]);
}

/**
 * Record evidence that contradicts an existing memory. Decays confidence
 * by `c' = c * 0.6` rather than removing the row outright — repeated
 * contradictions will eventually push it below the read threshold and
 * it'll stop showing up in prompts.
 */
export async function contradictMemory(
  pool: Pool,
  tenantId: string,
  type: MemoryType,
  key: string,
  sourceRunId?: string
): Promise<MemoryEntry | null> {
  const sql = `
    UPDATE tenant_memory
    SET confidence = confidence * 0.6,
        source_run_id = $4,
        updated_at = NOW()
    WHERE tenant_id = $1 AND type = $2 AND key = $3
    RETURNING *
  `;
  const { rows } = await pool.query(sql, [tenantId, type, key, sourceRunId ?? null]);
  return rows[0] ? rowToMemory(rows[0]) : null;
}

/** Hard-delete a memory. Use sparingly — prefer contradictMemory. */
export async function forgetMemory(
  pool: Pool,
  tenantId: string,
  type: MemoryType,
  key: string
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM tenant_memory WHERE tenant_id = $1 AND type = $2 AND key = $3`,
    [tenantId, type, key]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Query tenant memory. Filters by type if supplied. Default ordering:
 * most-recently-updated first. Excludes confidence < 0.25 by default —
 * those are entries we're starting to doubt.
 */
export async function queryMemory(
  pool: Pool,
  q: MemoryQuery
): Promise<MemoryEntry[]> {
  const limit = q.limit ?? 20;
  const minConfidence = q.excludeLowConfidence === false ? 0 : 0.25;

  // Build params + where clause symmetrically so positional args line up
  // exactly with the SQL placeholders. Easier to reason about than a
  // splice-based approach.
  const params = q.type
    ? [q.tenantId, q.type, minConfidence, limit]
    : [q.tenantId, minConfidence, limit];

  const where = q.type
    ? `tenant_id = $1 AND type = $2 AND confidence >= $3`
    : `tenant_id = $1 AND confidence >= $2`;

  const sql = `
    SELECT *
    FROM tenant_memory
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  return rows.map(rowToMemory);
}

/** Look up a single entry by exact key. */
export async function getMemoryByKey(
  pool: Pool,
  tenantId: string,
  type: MemoryType,
  key: string
): Promise<MemoryEntry | null> {
  const { rows } = await pool.query(
    `SELECT * FROM tenant_memory WHERE tenant_id = $1 AND type = $2 AND key = $3`,
    [tenantId, type, key]
  );
  return rows[0] ? rowToMemory(rows[0]) : null;
}

// ── run_scratchpad (L1) ─────────────────────────────────────────────

/**
 * Append an entry to a run's scratchpad. Append-only — never updates
 * existing rows. Multiple entries with the same key are allowed and
 * surfaced in insertion order.
 */
export async function scratchpadAppend(
  pool: Pool,
  input: ScratchpadInput
): Promise<ScratchpadEntry> {
  const id = randomUUID();
  const sql = `
    INSERT INTO run_scratchpad (id, run_id, key, value, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    RETURNING *
  `;
  const { rows } = await pool.query(sql, [id, input.runId, input.key, JSON.stringify(input.value)]);
  return rowToScratchpad(rows[0]);
}

/** All entries for a run, in insertion order. */
export async function scratchpadReadAll(
  pool: Pool,
  runId: string
): Promise<ScratchpadEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM run_scratchpad WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId]
  );
  return rows.map(rowToScratchpad);
}

/** All entries for a run with a specific key. */
export async function scratchpadReadByKey(
  pool: Pool,
  runId: string,
  key: string
): Promise<ScratchpadEntry[]> {
  const { rows } = await pool.query(
    `SELECT * FROM run_scratchpad WHERE run_id = $1 AND key = $2 ORDER BY created_at ASC`,
    [runId, key]
  );
  return rows.map(rowToScratchpad);
}

/**
 * Drop scratchpad entries older than `olderThanDays` days.
 * Run on a schedule — scratchpad is intentionally short-lived.
 */
export async function scratchpadPrune(
  pool: Pool,
  olderThanDays = 14
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM run_scratchpad WHERE created_at < NOW() - $1::interval`,
    [`${olderThanDays} days`]
  );
  return rowCount ?? 0;
}

// ── Transactional helper ────────────────────────────────────────────

/**
 * Run a function inside a single PG transaction. Useful when an agent's
 * end-of-run writes touch multiple memory tables and need to be atomic.
 */
export async function withMemoryTx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Row mapping ─────────────────────────────────────────────────────

interface MemoryRow {
  id: string;
  tenant_id: string;
  type: MemoryType;
  key: string;
  value: string;
  confidence: string | number;
  evidence_count: number;
  source_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToMemory(r: MemoryRow): MemoryEntry {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    key: r.key,
    value: r.value,
    confidence: typeof r.confidence === 'string' ? parseFloat(r.confidence) : r.confidence,
    evidenceCount: r.evidence_count,
    sourceRunId: r.source_run_id,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

interface ScratchpadRow {
  id: string;
  run_id: string;
  key: string;
  value: string;
  created_at: Date;
}

function rowToScratchpad(r: ScratchpadRow): ScratchpadEntry {
  return {
    id: r.id,
    runId: r.run_id,
    key: r.key,
    value: typeof r.value === 'string' ? safeParse(r.value) : r.value,
    createdAt: new Date(r.created_at),
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
