// src/cli/discoverMetadata.ts
//
// Phase 2, unit 3: run the metadata_edit discovery cycle on demand.
//   npm run discover:metadata <tenant>

import { pool } from '../memory/postgres'
import { logger } from '../logger'
import { runMetadataEditCycle } from '../skills/seo-discovery'

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId) { console.error('Usage: npm run discover:metadata <tenant>'); process.exit(1) }
  const r = await runMetadataEditCycle(tenantId)
  console.log(
    `✅ metadata_edit: scanned ${r.scanned}, candidates ${r.candidates}, ` +
    `filed ${r.filed}, skipped ${r.skipped}` +
    (r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''),
  )
  await pool.end()
}

main().catch((err) => {
  logger.error('discover_metadata_cli_failed', { err: String(err).slice(0, 400) })
  process.exit(1)
})
