// scripts/preview-tomorrows-bank.ts
//
// Dry-run preview of what `pickForDailyRun` would surface from the
// opportunity bank on the next daily cron. Runs the same load +
// score + diversity-cap logic but DOES NOT transition rows from
// 'new' to 'surfaced' — purely read-only.
//
// Usage:
//   npx tsx scripts/preview-tomorrows-bank.ts <tenantId>
//   npx tsx scripts/preview-tomorrows-bank.ts tarino
//
// Output: the up-to-7 opportunities that would be surfaced tomorrow,
// in priority order, with the score the picker would assign and the
// type-diversity check trail.

import { Pool } from 'pg'
import { config } from '../src/config'
import {
  scoreAndPick,
} from '../src/core/opportunity-bank/select'
import {
  FRESHNESS_WINDOW_DAYS,
  DIVERSITY_CAP_PER_TYPE,
  DEFAULT_SURFACE_LIMIT,
  type Opportunity,
} from '../src/core/opportunity-bank/types'

const tenantId = process.argv[2]
if (!tenantId) {
  console.error('usage: npx tsx scripts/preview-tomorrows-bank.ts <tenantId>')
  process.exit(1)
}

const pool = new Pool({ connectionString: config.DATABASE_URL })

;(async () => {
  const candidates = await loadNewCandidates(tenantId)

  console.log('─'.repeat(80))
  console.log(`Bank preview for tenant: ${tenantId}`)
  console.log(`Freshness window: ${FRESHNESS_WINDOW_DAYS} days`)
  console.log(`Surface limit: ${DEFAULT_SURFACE_LIMIT}`)
  console.log(`Per-type diversity cap: ${DIVERSITY_CAP_PER_TYPE}`)
  console.log('─'.repeat(80))

  if (candidates.length === 0) {
    console.log('\nNo new-state opportunities within the freshness window.')
    console.log('Tomorrow\'s daily run will surface zero from the bank and')
    console.log('lean entirely on LLM-driven inline discovery.\n')
    process.exit(0)
  }

  console.log(`\n${candidates.length} candidate(s) in the bank:\n`)
  const byType = new Map<string, number>()
  for (const c of candidates) {
    byType.set(c.type, (byType.get(c.type) ?? 0) + 1)
  }
  const typeRows = Array.from(byType.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `  ${t}: ${n}`)
    .join('\n')
  console.log(typeRows)

  console.log('\n' + '─'.repeat(80))
  console.log('Would surface tomorrow:\n')

  const picked = scoreAndPick(candidates, DEFAULT_SURFACE_LIMIT, DIVERSITY_CAP_PER_TYPE)

  if (picked.length === 0) {
    console.log('(nothing — diversity caps may have squeezed all candidates out)\n')
    process.exit(0)
  }

  picked.forEach((opp, i) => {
    const ageDays = Math.floor(
      (Date.now() - opp.createdAt.getTime()) / (24 * 60 * 60 * 1000),
    )
    const targetStr = opp.target ? ` → ${opp.target}` : ''
    console.log(
      `${i + 1}. [${opp.priority}] ${opp.type}${targetStr}`,
    )
    console.log(`     ${opp.description}`)
    console.log(`     age: ${ageDays}d | id: ${opp.id.slice(0, 8)}`)
    console.log('')
  })

  console.log('─'.repeat(80))
  console.log(`Total: ${picked.length} of ${DEFAULT_SURFACE_LIMIT} slots filled`)
  console.log(
    `Type distribution: ` +
      Object.entries(
        picked.reduce<Record<string, number>>((acc, o) => {
          acc[o.type] = (acc[o.type] ?? 0) + 1
          return acc
        }, {}),
      )
        .map(([t, n]) => `${t}=${n}`)
        .join(', '),
  )
  console.log('\nNote: read-only preview. Nothing has been transitioned.')
  console.log('Tomorrow\'s actual daily run will atomically flip these rows')
  console.log('from new → surfaced and create approval_requests for each.\n')
  process.exit(0)
})().catch((err) => {
  console.error('preview failed:', err)
  process.exit(1)
})

async function loadNewCandidates(tenantId: string): Promise<Opportunity[]> {
  const sql = `
    SELECT
      id, tenant_id AS "tenantId", run_id AS "runId", type, target,
      description, rationale, priority, status,
      estimated_impact AS "estimatedImpact",
      created_at AS "createdAt", updated_at AS "updatedAt",
      surfaced_in_run_id AS "surfacedInRunId",
      surfaced_at AS "surfacedAt",
      dismissed_reason AS "dismissedReason",
      reshape_source_id AS "reshapeSourceId",
      reshape_target_id AS "reshapeTargetId",
      reshape_count AS "reshapeCount",
      resolved_run_id AS "resolvedRunId"
    FROM seo_opportunities
    WHERE tenant_id = $1
      AND status = 'new'
      AND created_at > NOW() - ($2::int * INTERVAL '1 day')
    ORDER BY priority ASC, created_at DESC
    LIMIT 200
  `
  const result = await pool.query<Opportunity>(sql, [tenantId, FRESHNESS_WINDOW_DAYS])
  return result.rows
}
