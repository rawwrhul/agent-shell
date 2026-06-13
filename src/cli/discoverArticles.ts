// src/cli/discoverArticles.ts
//   npm run discover:articles <tenant>
import { pool } from '../memory/postgres'
import { logger } from '../logger'
import { runArticleCreateCycle } from '../skills/seo-discovery'

async function main(): Promise<void> {
  const tenantId = process.argv[2]
  if (!tenantId) { console.error('Usage: npm run discover:articles <tenant>'); process.exit(1) }
  const r = await runArticleCreateCycle(tenantId)
  console.log(
    `✅ article_create: scanned ${r.scanned}, candidates ${r.candidates}, ` +
    `filed ${r.filed}, skipped ${r.skipped}` +
    (r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''),
  )
  await pool.end()
}
main().catch((err) => { logger.error('discover_articles_cli_failed', { err: String(err).slice(0, 400) }); process.exit(1) })
