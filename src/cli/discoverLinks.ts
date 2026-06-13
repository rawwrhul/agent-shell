// src/cli/discoverLinks.ts
//   npm run discover:links <tenant>
import { pool } from '../memory/postgres'
import { logger } from '../logger'
import { runInternalLinkCycle } from '../skills/seo-discovery'

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId) { console.error('Usage: npm run discover:links <tenant>'); process.exit(1) }
  const r = await runInternalLinkCycle(tenantId)
  console.log(
    `✅ internal_link: scanned ${r.scanned}, candidates ${r.candidates}, ` +
    `filed ${r.filed}, skipped ${r.skipped}` +
    (r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''),
  )
  await pool.end()
}
main().catch((err) => { logger.error('discover_links_cli_failed', { err: String(err).slice(0, 400) }); process.exit(1) })
