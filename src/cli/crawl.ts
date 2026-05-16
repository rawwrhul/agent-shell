// src/cli/crawl.ts
//
// CLI for manual crawls. Reads tenant.target_domain (and optionally a
// sitemap URL), runs the crawler with sensible defaults, prints a summary
// you can paste into a Slack thread or Sheet.
//
// Usage:
//   npm run crawl <tenantId>
//   npm run crawl tarino --max-pages 200 --depth 5
//   npm run crawl tarino --no-robots          # disable robots.txt (use sparingly)
//   npm run crawl tarino --seed https://...   # additional seed URL(s)
//
// Exits 0 on completion, 1 on validation error or fatal crawl error.

import 'dotenv/config'
import { Pool } from 'pg'
import { config } from '../config'
import { runCrawl } from '../core/crawler'
import {
  getCrawlSummaryStats,
  findOrphans,
  findBrokenInternalLinks,
} from '../core/crawler/store'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.tenantId) {
    console.error('Usage: npm run crawl <tenantId> [--max-pages N] [--depth N] [--no-robots] [--seed URL ...]')
    process.exit(1)
  }

  // Pull tenant config inline — we don't import the registry to keep this
  // CLI startup light.
  const pool = new Pool({ connectionString: config.DATABASE_URL })
  let targetDomain: string | null
  try {
    const { rows } = await pool.query(
      `SELECT target_domain FROM tenants WHERE tenant_id = $1`,
      [args.tenantId],
    )
    if (!rows.length) {
      console.error(`Tenant not found: ${args.tenantId}`)
      process.exit(1)
    }
    targetDomain = rows[0].target_domain
    if (targetDomain && !/^https?:\/\//i.test(targetDomain)) {
      targetDomain = 'https://' + targetDomain
    }
    if (!targetDomain) {
      console.error(`Tenant ${args.tenantId} has no target_domain set. ` +
        `Set it in tenants table before crawling.`)
      process.exit(1)
    }
  } finally {
    await pool.end()
  }

  // Build seed list: target_domain root + sitemap.xml + any user-supplied seeds.
  const seedUrls = [
    ensureTrailingSlash(targetDomain),
    new URL('/sitemap.xml', targetDomain).href,
    ...args.extraSeeds,
  ]

  console.log(`\n→ Crawling ${args.tenantId} (${targetDomain})`)
  console.log(`  Seeds: ${seedUrls.join(', ')}`)
  console.log(`  Limits: maxPages=${args.maxPages}, maxDepth=${args.maxDepth}, throttle=${args.throttleMs}ms`)
  console.log(`  Robots: ${args.respectRobots ? 'respected' : 'IGNORED'}`)
  console.log()

  const t0 = Date.now()
  const summary = await runCrawl({
    tenantId:      args.tenantId,
    seedUrls,
    crawlKind:     'full',
    maxPages:      args.maxPages,
    maxDepth:      args.maxDepth,
    throttleMs:    args.throttleMs,
    respectRobots: args.respectRobots,
  })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  console.log(`\n✅ Crawl ${summary.status} in ${elapsed}s`)
  console.log(`   Pages crawled: ${summary.pagesCrawled}`)
  console.log(`   Pages failed:  ${summary.pagesFailed}`)
  console.log(`   Pages skipped: ${summary.pagesSkipped}`)
  if (summary.error) console.log(`   Error: ${summary.error}`)
  if (summary.samples.length) {
    console.log(`\n   Sample pages:`)
    for (const s of summary.samples) {
      console.log(`     [${s.status}] ${s.url}  — ${s.title ?? '(no title)'}`)
    }
  }

  // Bonus: print high-signal stats so the operator gets immediate value.
  console.log()
  console.log('─── Inventory stats ───')
  const stats = await getCrawlSummaryStats(args.tenantId)
  console.log(`   Total pages:       ${stats.totalPages}`)
  console.log(`   Status breakdown:  ${JSON.stringify(stats.pagesByStatus)}`)
  console.log(`   Missing H1:        ${stats.pagesMissingH1}`)
  console.log(`   Missing meta desc: ${stats.pagesMissingMeta}`)
  console.log(`   Noindex pages:     ${stats.pagesNoIndex}`)
  console.log(`   Orphaned pages:    ${stats.orphanedPages}`)
  console.log(`   Internal edges:    ${stats.totalEdges}`)

  if (stats.orphanedPages > 0 && stats.orphanedPages <= 20) {
    console.log('\n─── Orphans ───')
    const orphans = await findOrphans({ tenantId: args.tenantId, limit: 20 })
    for (const o of orphans) {
      console.log(`   ${o.url}  — ${o.title ?? '(no title)'}`)
    }
  }

  const broken = await findBrokenInternalLinks({ tenantId: args.tenantId, limit: 20 })
  if (broken.length) {
    console.log(`\n─── Broken internal links (${broken.length}) ───`)
    for (const b of broken) {
      const status = b.targetStatus ?? (b.targetError ? `err` : '?')
      console.log(`   [${status}] ${b.sourceUrl}  →  ${b.targetUrl}`)
    }
  }

  if (summary.status === 'failed') process.exit(1)
}

interface Args {
  tenantId:      string | null
  maxPages:      number
  maxDepth:      number
  throttleMs:    number
  respectRobots: boolean
  extraSeeds:    string[]
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    tenantId:      null,
    maxPages:      500,
    maxDepth:      8,
    throttleMs:    500,
    respectRobots: true,
    extraSeeds:    [],
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--max-pages') out.maxPages = Number(argv[++i])
    else if (a === '--depth' || a === '--max-depth') out.maxDepth = Number(argv[++i])
    else if (a === '--throttle' || a === '--throttle-ms') out.throttleMs = Number(argv[++i])
    else if (a === '--no-robots') out.respectRobots = false
    else if (a === '--seed') out.extraSeeds.push(argv[++i])
    else if (!a.startsWith('--') && !out.tenantId) out.tenantId = a
  }

  return out
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : s + '/'
}

main().catch((err) => {
  console.error('crawl CLI failed:', err)
  process.exit(1)
})
