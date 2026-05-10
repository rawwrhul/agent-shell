// src/memory/runtime.ts
//
// Runtime-bound wrappers around the memory store. Holds a singleton pool
// initialised on first use from config.DATABASE_URL. Use these instead of
// the raw functions in src/memory/store.ts when calling from the
// orchestrator, subagents, or any code path that doesn't already have a
// pool to thread through.

import { Pool } from 'pg'
import { config } from '../config'
import * as store from './store'
import { getMemoryContext as getMemoryContextRaw, toPromptString } from './context'
import type {
  MemoryInput, MemoryQuery, MemoryEntry, MemoryType,
  ScratchpadInput, ScratchpadEntry,
  MemoryContext,
} from './types'
import type { GetMemoryContextOptions } from './context'

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: config.DATABASE_URL })
  }
  return _pool
}

// ── tenant_memory (L2) ──────────────────────────────────────────────────────

export async function recordMemory(input: MemoryInput): Promise<MemoryEntry> {
  return store.recordMemory(pool(), input)
}

export async function queryMemory(q: MemoryQuery): Promise<MemoryEntry[]> {
  return store.queryMemory(pool(), q)
}

export async function getMemoryByKey(
  tenantId: string, type: MemoryType, key: string
): Promise<MemoryEntry | null> {
  return store.getMemoryByKey(pool(), tenantId, type, key)
}

export async function contradictMemory(
  tenantId: string, type: MemoryType, key: string, sourceRunId?: string
): Promise<MemoryEntry | null> {
  return store.contradictMemory(pool(), tenantId, type, key, sourceRunId)
}

// ── run_scratchpad (L1) ─────────────────────────────────────────────────────

export async function scratchpadAppend(input: ScratchpadInput): Promise<ScratchpadEntry> {
  return store.scratchpadAppend(pool(), input)
}

export async function scratchpadReadAll(runId: string): Promise<ScratchpadEntry[]> {
  return store.scratchpadReadAll(pool(), runId)
}

export async function scratchpadReadByKey(runId: string, key: string): Promise<ScratchpadEntry[]> {
  return store.scratchpadReadByKey(pool(), runId, key)
}

// ── Context assembly ────────────────────────────────────────────────────────

export async function getMemoryContext(
  opts: Omit<GetMemoryContextOptions, never>
): Promise<MemoryContext> {
  return getMemoryContextRaw(pool(), opts)
}

export { toPromptString }
