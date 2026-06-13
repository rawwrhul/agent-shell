// src/cli/discoverCopy.ts
//   npm run discover:copy <tenant>
import { pool } from '../memory/postgres'
import { logger } from '../logger'
import { runCopyOptimiseCycle } from '../skills/seo-discovery'

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId) { console.error('Usage: npm run discover:copy <tenant>'); process.exit(1) }
  const r = await runCopyOptimiseCycle(tenantId)
  console.log(
    `✅ copy_optimise: scanned ${r.scanned}, candidates ${r.candidates}, ` +
    `filed ${r.filed}, skipped ${r.skipped}` +
    (r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''),
  )
  await pool.end()
}
main().catch((err) => { logger.error('discover_copy_cli_failed', { err: String(err).slice(0, 400) }); process.exit(1) })
