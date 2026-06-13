// src/cli/strategyRefresh.ts
//
// Phase 2, build unit 2: ad-hoc strategy refresh.
//
//   npm run strategy:refresh <tenant>            # forced refresh
//   npm run strategy:refresh <tenant> --cold     # forced, cold-start framing
//
// The cron path (runKind 'strategy_refresh') runs the same cycle weekly with
// the freshness guard; this CLI forces a refresh regardless of age.

import { pool } from '../memory/postgres'
import { logger } from '../logger'
import { runStrategyRefreshCycle } from '../core/strategy/refresh'

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId) {
    console.error('Usage: npm run strategy:refresh <tenant> [--cold]')
    process.exit(1)
  }
  const coldStart = process.argv.includes('--cold')

  const res = await runStrategyRefreshCycle(tenantId, { force: true, coldStart })
  if (res.skipped) {
    console.log(`Skipped: ${res.reason}`)
  } else {
    console.log(`✅ Strategy v${res.version} written for ${tenantId} (clusters updated: ${res.clustersUpdated ?? 0}).`)
    if (res.warnings && res.warnings.length) {
      console.log(`   Normaliser warnings: ${res.warnings.length}`)
      for (const w of res.warnings.slice(0, 10)) console.log(`     - ${w}`)
    }
  }
  await pool.end()
}

main().catch((err) => {
  logger.error('strategy_refresh_cli_failed', { err: String(err).slice(0, 400) })
  process.exit(1)
})
