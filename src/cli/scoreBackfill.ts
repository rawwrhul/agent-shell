// src/cli/scoreBackfill.ts
//
// Phase 2, build unit 1: one-time backfill of `score` on existing
// opportunities. Legacy rows lack the structured target+keyword inputs to
// compute a real EV, so they get a conservative priority-derived default
// (decision 2) — enough to keep P0>P1>P2 ordering sane once select.ts ranks
// on score. Cycles (unit 3) overwrite these with real EV scores as they
// re-file. Idempotent: only touches rows where score IS NULL.
//
//   npm run score:backfill            # all tenants
//   npm run score:backfill <tenant>   # one tenant

import { pool } from '../memory/postgres'
import { logger } from '../logger'
import { defaultScoreForPriority } from '../core/opportunity-bank/scoring'

async function main(): Promise<void> {
  const tenantArg = process.argv[2]
  const params: unknown[] = []
  let where = `status IN ('new','surfaced','queued','in_progress') AND score IS NULL`
  if (tenantArg) {
    where += ` AND tenant_id = $1`
    params.push(tenantArg)
  }

  const rows = await pool.query<{ id: string; priority: string }>(
    `SELECT id, priority FROM seo_opportunities WHERE ${where}`,
    params,
  )

  console.log(
    `Backfilling score for ${rows.rows.length} unscored actionable opportunities` +
    `${tenantArg ? ` (tenant ${tenantArg})` : ''}…`,
  )

  let updated = 0
  for (const r of rows.rows) {
    const score = defaultScoreForPriority(r.priority)
    const res = await pool.query(
      `UPDATE seo_opportunities
         SET score        = $2,
             score_inputs = jsonb_build_object('source', 'legacy-backfill', 'fromPriority', priority),
             updated_at   = NOW()
       WHERE id = $1 AND score IS NULL`,
      [r.id, score],
    )
    updated += res.rowCount ?? 0
  }

  console.log(`✅ Backfilled ${updated} rows.`)
  await pool.end()
}

main().catch((err) => {
  logger.error('score_backfill_failed', { err: String(err).slice(0, 400) })
  process.exit(1)
})
