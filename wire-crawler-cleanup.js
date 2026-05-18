// wire-crawler-cleanup.js
//
// Bundle 2 of the next merge: crawler hygiene improvements.
//
//   Item 1 — Skip sitemap.xml / robots.txt from seo_page_inventory.
//     Auditor was producing missing_h1 / missing_meta_description findings
//     on these directive files. They aren't pages; they shouldn't be in
//     the inventory.
//
//   Item 3 — Robots.txt content-type bug. fetchPolite() only returned the
//     body for text/html, but robots.txt is served as text/plain. Result:
//     robots-parser never saw the contents, so robots.txt was effectively
//     never respected. Fix: add optional acceptContentTypes to
//     FetchPoliteOptions and pass it from robots.ts.
//
// Three files patched, all in src/core/crawler/:
//   - fetcher.ts  — FetchPoliteOptions interface + gating check
//   - robots.ts   — pass acceptContentTypes when fetching robots.txt
//   - crawler.ts  — directive-URL filter in BFS loop + helper
//
// Idempotent: re-running after success exits 0 without changing anything.
// Atomic: if any anchor is missing, NO files are modified.
//
// Usage (from repo root):
//   node wire-crawler-cleanup.js
//
// After running:
//   npx tsc --noEmit
//   npm run audit tarino   # optional — should no longer flag sitemap.xml

const fs = require('fs')
const path = require('path')

const repo = process.cwd()

// ── Patch specs ──────────────────────────────────────────────────────────

const patches = [
  {
    file:   'src/core/crawler/fetcher.ts',
    label:  'fetcher: add acceptContentTypes option',
    sentinel: 'acceptContentTypes?: string[]',
    edits: [
      {
        anchor: `export interface FetchPoliteOptions {
  /** Per-request timeout in ms. */
  timeoutMs:  number
  /** User-Agent header. */
  userAgent:  string
  /** Throttle delay applied AFTER the response returns (so the next call
   *  in the same loop iteration is naturally spaced). Default 500ms. */
  throttleMs: number
}`,
        replacement: `export interface FetchPoliteOptions {
  /** Per-request timeout in ms. */
  timeoutMs:  number
  /** User-Agent header. */
  userAgent:  string
  /** Throttle delay applied AFTER the response returns (so the next call
   *  in the same loop iteration is naturally spaced). Default 500ms. */
  throttleMs: number
  /** Content-type prefixes whose body should be returned. Defaults to
   *  HTML variants only. Callers fetching non-HTML resources (robots.txt,
   *  sitemaps, JSON APIs) can widen this. Match is case-insensitive
   *  substring against the content-type header. */
  acceptContentTypes?: string[]
}`,
      },
      {
        anchor: `      const contentType = res.headers.get('content-type')
      const isHtml = contentType !== null && HTML_CONTENT_TYPES.some(
        (t) => contentType.toLowerCase().includes(t),
      )`,
        replacement: `      const contentType = res.headers.get('content-type')
      const acceptList = opts.acceptContentTypes ?? HTML_CONTENT_TYPES
      const isHtml = contentType !== null && acceptList.some(
        (t) => contentType.toLowerCase().includes(t.toLowerCase()),
      )`,
      },
    ],
  },

  {
    file:   'src/core/crawler/robots.ts',
    label:  'robots: pass acceptContentTypes when fetching robots.txt',
    sentinel: `acceptContentTypes: ['text/plain'`,
    edits: [
      {
        anchor: `    const res = await fetchPolite(robotsUrl, {
      timeoutMs:  opts.fetchTimeoutMs,
      userAgent,
      throttleMs: 0,  // robots.txt fetches don't count toward crawl politeness budget
    })`,
        replacement: `    const res = await fetchPolite(robotsUrl, {
      timeoutMs:  opts.fetchTimeoutMs,
      userAgent,
      throttleMs: 0,  // robots.txt fetches don't count toward crawl politeness budget
      // robots.txt is typically text/plain, not HTML — widen the accept
      // list so fetcher returns the body instead of dropping it.
      acceptContentTypes: ['text/plain', 'text/html', 'application/xhtml+xml'],
    })`,
      },
    ],
  },

  {
    file:   'src/core/crawler/crawler.ts',
    label:  'crawler: skip directive URLs (sitemap.xml, robots.txt)',
    sentinel: 'function isDirectiveUrl',
    edits: [
      {
        anchor: `      const { url, depth } = queue.shift()!
      if (visited.has(url)) continue
      visited.add(url)

      // ── Host gating ──────────────────────────────────────────────────`,
        replacement: `      const { url, depth } = queue.shift()!
      if (visited.has(url)) continue
      visited.add(url)

      // ── Directive-file filter ────────────────────────────────────────
      // sitemap.xml / robots.txt aren't pages — they're directive files.
      // Skip them from the page inventory entirely so the auditor doesn't
      // flag them for missing_h1 / missing_meta_description.
      if (isDirectiveUrl(url)) {
        pagesSkipped++
        logger.debug('crawler_skipped_directive', { runId, url })
        continue
      }

      // ── Host gating ──────────────────────────────────────────────────`,
      },
      {
        anchor: `function isNoIndex(metaRobots: string | null): boolean {
  if (!metaRobots) return false
  return metaRobots.toLowerCase().split(/[,\\s]+/).includes('noindex')
}

function minimalInventoryForNonHtml(r: FetchResult): ParsedPage {`,
        replacement: `function isNoIndex(metaRobots: string | null): boolean {
  if (!metaRobots) return false
  return metaRobots.toLowerCase().split(/[,\\s]+/).includes('noindex')
}

/** Detect URLs that are directive files (sitemap, robots) rather than
 *  pages. These should never enter the page inventory. */
function isDirectiveUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase()
    if (p === '/robots.txt') return true
    // Matches /sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml,
    // /post-sitemap.xml, /sitemaps/main.xml, /sitemap.xml.gz, etc.
    if ((p.endsWith('.xml') || p.endsWith('.xml.gz')) && p.includes('sitemap')) {
      return true
    }
    return false
  } catch {
    return false
  }
}

function minimalInventoryForNonHtml(r: FetchResult): ParsedPage {`,
      },
    ],
  },
]

// ── Apply ────────────────────────────────────────────────────────────────

// Pre-flight: check every file exists and either is already patched or has
// all anchors. We don't write anything until all checks pass.

const plan = []
let alreadyPatched = 0

for (const p of patches) {
  const abs = path.resolve(repo, p.file)
  if (!fs.existsSync(abs)) {
    console.error(`ERROR: target file not found: ${p.file}`)
    console.error('Run this script from the repo root (directory with package.json).')
    process.exit(1)
  }
  const src = fs.readFileSync(abs, 'utf8')

  if (src.includes(p.sentinel)) {
    console.log(`• ${p.label}: already patched, skipping`)
    alreadyPatched++
    plan.push({ ...p, abs, src, skip: true })
    continue
  }

  for (const e of p.edits) {
    if (!src.includes(e.anchor)) {
      console.error(`ERROR: anchor text not found in ${p.file}`)
      console.error('The file may have drifted since this patch was authored.')
      console.error('No files have been modified.')
      console.error('')
      console.error('Expected anchor (first 200 chars):')
      console.error(e.anchor.slice(0, 200) + (e.anchor.length > 200 ? '...' : ''))
      process.exit(1)
    }
  }
  plan.push({ ...p, abs, src, skip: false })
}

if (alreadyPatched === patches.length) {
  console.log('')
  console.log('✓ All patches already applied. No changes made.')
  process.exit(0)
}

// All-or-nothing apply.
for (const item of plan) {
  if (item.skip) continue
  let src = item.src
  for (const e of item.edits) {
    src = src.replace(e.anchor, e.replacement)
  }
  fs.writeFileSync(item.abs, src)
  console.log(`✓ Patched ${item.file}`)
}

console.log('')
console.log('Bundle 2 applied. Next steps:')
console.log('  1. npx tsc --noEmit            # verify type-check passes')
console.log('  2. git diff src/core/crawler/  # eyeball the changes')
console.log('  3. npm run audit tarino        # optional — verify clean audit')
