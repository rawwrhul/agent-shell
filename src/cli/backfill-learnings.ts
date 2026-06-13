#!/usr/bin/env tsx
// Usage: npm run backfill:learnings <tenant-id>
//
// One-shot: seed agent_learnings (the Voyage vector store that Phase 4 Lever 3
// recall reads) from the tenant's existing tenant_memory `loss` and `learning`
// rows, so semantic recall isn't cold on the day the new code ships.
//
// PREREQUISITES (same as Lever 3 itself):
//   1. agent_learnings.embedding is vector(1024)  →  npm run db:migrate
//   2. VOYAGE_API_KEY is set                       →  else every row skips
// Without either, this exits having written nothing (loudly), harmlessly.
//
// Safe to interrupt and re-run: each row is content-deduped against
// agent_learnings before insert, so re-running never double-writes.

import 'dotenv/config'
import { pool } from '../memory/postgres'
import { getTenant } from '../tenants/registry'
import { queryMemory } from '../memory/store'
import { storeLearning } from '../memory/vector'
import { config } from '../config'
import type { MemoryEntry } from '../memory/types'

const AGENT_TYPE = 'content-pipeline' // same bucket the live pipeline writes use

function kindOf(type: MemoryEntry['type'], value: string): string {
  if (/^\[rejected/i.test(value))      return 'rejection'
  if (/^\[publish failed/i.test(value)) return 'publish_failure'
  if (/^\[approved/i.test(value) || /^\[published/i.test(value)) return 'approval'
  return type === 'loss' ? 'rejection' : 'approval'
}

async function alreadyStored(tenantId: string, content: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM agent_learnings WHERE tenant_id=$1 AND content=$2 LIMIT 1`,
    [tenantId, content],
  )
  return r.rows.length > 0
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const tenantId = process.argv[2]
  if (!tenantId) { console.error('Usage: npm run backfill:learnings <tenant-id>'); process.exit(1) }
  if (!config.VOYAGE_API_KEY) {
    console.error('VOYAGE_API_KEY is not set — semantic memory is disabled, nothing to backfill. Set it and re-run.')
    process.exit(1)
  }

  await getTenant(tenantId) // validates the tenant exists; throws if not

  // Pull all loss + learning rows (high limit, include low-confidence — we
  // want the full operator history, not just the high-signal recent slice).
  const [losses, learnings] = await Promise.all([
    queryMemory(pool, { tenantId, type: 'loss',     limit: 10_000, excludeLowConfidence: false }),
    queryMemory(pool, { tenantId, type: 'learning', limit: 10_000, excludeLowConfidence: false }),
  ])
  const rows = [...losses, ...learnings]
  console.log(`\nBackfilling ${tenantId}: ${rows.length} candidate rows (${losses.length} loss, ${learnings.length} learning)\n`)

  let written = 0, skipped = 0, failed = 0
  for (const e of rows) {
    try {
      if (await alreadyStored(tenantId, e.value)) { skipped++; process.stdout.write('·'); continue }
      await storeLearning({
        tenantId,
        agentType: AGENT_TYPE,
        content:   e.value,
        metadata:  { kind: kindOf(e.type, e.value), source: 'backfill', origin_key: e.key },
      })
      written++; process.stdout.write('+')
      await sleep(200) // be gentle on the Voyage embeddings endpoint
    } catch (err) {
      failed++; process.stdout.write('x')
      console.error(`\n  failed on key=${e.key}: ${String(err).slice(0, 160)}`)
    }
  }

  console.log(`\n\n✅ Backfill complete — wrote ${written}, skipped ${skipped} (already present), failed ${failed}\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('Backfill failed:', err); process.exit(1) })
