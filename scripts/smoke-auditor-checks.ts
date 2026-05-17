// scripts/smoke-auditor-checks.ts
//
// Stand-alone smoke test for the 9 audit check functions. Uses synthetic
// PageInventory + InternalLink data — no network, no DB. ~40 assertions.
//
// Run: tsx scripts/smoke-auditor-checks.ts
// Or:  npm run smoke:auditor

import { ALL_CHECKS } from '../src/skills/seo-technical-auditor/checks'
import { applyNavHeuristic } from '../src/skills/seo-technical-auditor/nav-heuristic'
import { computeDelta } from '../src/skills/seo-technical-auditor/delta'
import type {
  CheckContext, PageInventory, InternalLink, RawFinding, ResolvedFinding,
} from '../src/skills/seo-technical-auditor/types'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const RESET = '\x1b[0m'

let failed = 0
function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`${GREEN}✓${RESET} ${name}`)
  } else {
    console.log(`${RED}✗${RESET} ${name}${detail ? `  — ${detail}` : ''}`)
    failed++
  }
}

// ── Test fixture: synthetic Tarino-like site ──────────────────────────────

function makePage(opts: Partial<PageInventory> & { url: string }): PageInventory {
  return {
    url:              opts.url,
    finalUrl:         opts.finalUrl ?? opts.url,
    httpStatus:       opts.httpStatus ?? 200,
    title:            opts.title ?? `Page ${opts.url}`,
    metaDescription:  'metaDescription' in opts ? opts.metaDescription! : 'Default meta description for this page.',
    canonicalUrl:     opts.canonicalUrl ?? null,
    metaRobots:       opts.metaRobots ?? null,
    h1Count:          opts.h1Count ?? 1,
    h1First:          opts.h1First ?? 'A heading',
    schemaTypes:      opts.schemaTypes ?? [],
    ogImage:          opts.ogImage ?? null,
    language:         opts.language ?? 'en',
    wordCount:        opts.wordCount ?? 500,
    internalLinksOut: opts.internalLinksOut ?? 5,
    externalLinksOut: opts.externalLinksOut ?? 0,
    imageCount:       opts.imageCount ?? 0,
    imagesWithAlt:    opts.imagesWithAlt ?? 0,
    imagesMissingAlt: opts.imagesMissingAlt ?? 0,
    lastCrawledAt:    new Date('2026-05-16T12:00:00Z'),
    fetchError:       opts.fetchError ?? null,
  }
}

function makeLink(
  sourceUrl: string,
  targetUrl: string,
  opts: Partial<InternalLink> = {},
): InternalLink {
  return {
    sourceUrl,
    targetUrl,
    anchorText:    opts.anchorText ?? 'link',
    rel:           opts.rel ?? null,
    isNav:         opts.isNav ?? false,
    positionIndex: opts.positionIndex ?? 0,
  }
}

const pages: PageInventory[] = [
  makePage({ url: 'https://tarino.au/' }),
  makePage({ url: 'https://tarino.au/about', title: 'About Tarino' }),
  makePage({ url: 'https://tarino.au/contact', title: 'Contact Tarino' }),
  // Three pages all sharing the same title (duplicate_titles trigger at 3+)
  makePage({ url: 'https://tarino.au/services/a', title: 'Our Services | Tarino' }),
  makePage({ url: 'https://tarino.au/services/b', title: 'Our Services | Tarino' }),
  makePage({ url: 'https://tarino.au/services/c', title: 'Our Services | Tarino' }),
  // Page with no H1
  makePage({ url: 'https://tarino.au/no-h1',         h1Count: 0, h1First: null }),
  // Page with multiple H1s
  makePage({ url: 'https://tarino.au/many-h1',       h1Count: 3 }),
  // Page missing meta description
  makePage({ url: 'https://tarino.au/no-meta',       metaDescription: null }),
  // Orphan: indexable, has no inbound non-nav links
  makePage({ url: 'https://tarino.au/orphan',        title: 'Orphan' }),
  // 404 page (broken internal link target)
  makePage({ url: 'https://tarino.au/broken',        httpStatus: 404 }),
  // Canonical to a 404
  makePage({
    url: 'https://tarino.au/canonical-to-404',
    canonicalUrl: 'https://tarino.au/broken',
  }),
  // Cross-canonical (points to unrelated existing page)
  makePage({
    url: 'https://tarino.au/cross-canonical',
    canonicalUrl: 'https://tarino.au/about',
  }),
  // Noindex page (excluded from indexable-only checks)
  makePage({
    url: 'https://tarino.au/private',
    metaRobots: 'noindex,nofollow',
  }),
]

const links: InternalLink[] = [
  // Homepage links out to almost everything (will trigger nav-heuristic for some targets)
  makeLink('https://tarino.au/',         'https://tarino.au/about'),
  makeLink('https://tarino.au/',         'https://tarino.au/contact'),
  makeLink('https://tarino.au/',         'https://tarino.au/services/a'),
  makeLink('https://tarino.au/',         'https://tarino.au/no-h1'),
  makeLink('https://tarino.au/',         'https://tarino.au/no-meta'),
  makeLink('https://tarino.au/',         'https://tarino.au/many-h1'),
  // /about links to /broken — broken_internal_link finding
  makeLink('https://tarino.au/about',    'https://tarino.au/broken',   { anchorText: 'click here' }),
  // /contact links to /no-h1 (so /no-h1 has 2 inbound, not an orphan)
  makeLink('https://tarino.au/contact',  'https://tarino.au/no-h1'),
  // services/a inter-link to b and c — so a/b/c are not orphans
  makeLink('https://tarino.au/services/a', 'https://tarino.au/services/b'),
  makeLink('https://tarino.au/services/a', 'https://tarino.au/services/c'),
  // Nothing links to /orphan or /cross-canonical or /canonical-to-404 (other than nav-style global links)
  // Footer-style links appearing on multiple pages (sim. Framer non-semantic footer)
  makeLink('https://tarino.au/',         'https://tarino.au/about',   { positionIndex: 99 }),
  makeLink('https://tarino.au/about',    'https://tarino.au/contact', { positionIndex: 99 }),
  makeLink('https://tarino.au/contact',  'https://tarino.au/about',   { positionIndex: 99 }),
]

// ── Build context ─────────────────────────────────────────────────────────
const ctxBase: CheckContext = {
  tenantId: 'tarino',
  pages,
  links: applyNavHeuristic(links, pages),
  sitemapUrls: new Set([
    'https://tarino.au/',
    'https://tarino.au/about',
    'https://tarino.au/contact',
    'https://tarino.au/broken',           // sitemap pointing at a 404 — sitemap_url_404 trigger
    'https://tarino.au/services/a',
    'https://tarino.au/services/b',
    'https://tarino.au/services/c',
    'https://tarino.au/no-h1',
    'https://tarino.au/many-h1',
    'https://tarino.au/no-meta',
    'https://tarino.au/canonical-to-404',
    'https://tarino.au/cross-canonical',
    // /orphan is NOT in sitemap → missing_from_sitemap trigger
  ]),
  excludeFromOrphans: new Set(),
}

// ── Run checks + assertions ───────────────────────────────────────────────

async function runAll(): Promise<RawFinding[]> {
  const out: RawFinding[] = []
  for (const c of ALL_CHECKS) {
    const result = await c.fn(ctxBase)
    out.push(...result)
  }
  return out
}

;(async () => {
  const findings = await runAll()

  const byCheck = new Map<string, RawFinding[]>()
  for (const f of findings) {
    if (!byCheck.has(f.checkName)) byCheck.set(f.checkName, [])
    byCheck.get(f.checkName)!.push(f)
  }
  const get = (n: string): RawFinding[] => byCheck.get(n) ?? []

  console.log(`\n${findings.length} total findings across ${byCheck.size} check types\n`)

  // ── broken_internal_links ──
  check('broken_internal_link: detected', get('broken_internal_link').length >= 1)
  check(
    'broken_internal_link: target is /broken',
    get('broken_internal_link').some((f) => f.relatedUrl === 'https://tarino.au/broken'),
  )
  check(
    'broken_internal_link: severity P1',
    get('broken_internal_link').every((f) => f.severity === 'P1'),
  )

  // ── orphan_pages ──
  // Should flag /orphan. Should NOT flag pages reached by the nav heuristic
  // (every-page links).
  const orphans = get('orphan_page').map((f) => f.targetUrl)
  check('orphan_page: flagged /orphan', orphans.includes('https://tarino.au/orphan'))
  // /canonical-to-404 and /cross-canonical are orphans too (no inbound) — that's expected.
  check('orphan_page: not flagging /about (linked from homepage)', !orphans.includes('https://tarino.au/about'))
  check(
    'orphan_page: severity P2',
    get('orphan_page').every((f) => f.severity === 'P2'),
  )

  // ── missing_meta_description ──
  check(
    'missing_meta_description: flagged /no-meta',
    get('missing_meta_description').some((f) => f.targetUrl === 'https://tarino.au/no-meta'),
  )
  check(
    'missing_meta_description: not flagging pages WITH descriptions',
    !get('missing_meta_description').some((f) => f.targetUrl === 'https://tarino.au/'),
  )

  // ── missing_h1 ──
  const missingH1Urls = get('missing_h1').map((f) => f.targetUrl)
  check('missing_h1: flagged /no-h1', missingH1Urls.includes('https://tarino.au/no-h1'))
  check('missing_h1: not flagging /many-h1', !missingH1Urls.includes('https://tarino.au/many-h1'))
  check(
    'missing_h1: severity P1 on indexable',
    get('missing_h1').find((f) => f.targetUrl === 'https://tarino.au/no-h1')?.severity === 'P1',
  )

  // ── multiple_h1 ──
  check(
    'multiple_h1: flagged /many-h1',
    get('multiple_h1').some((f) => f.targetUrl === 'https://tarino.au/many-h1'),
  )
  check(
    'multiple_h1: severity P3',
    get('multiple_h1').every((f) => f.severity === 'P3'),
  )

  // ── canonical_conflict ──
  const canonicalFindings = get('canonical_conflict')
  check('canonical_conflict: at least 2 findings (404 + cross)', canonicalFindings.length >= 2)
  check(
    'canonical_conflict: caught canonical_404',
    canonicalFindings.some((f) => (f.detail as { kind: string }).kind === 'canonical_404'),
  )
  check(
    'canonical_conflict: caught cross_canonical',
    canonicalFindings.some((f) => (f.detail as { kind: string }).kind === 'cross_canonical'),
  )
  check(
    'canonical_conflict: all P0',
    canonicalFindings.every((f) => f.severity === 'P0'),
  )

  // ── sitemap_inconsistency ──
  const sitemap = get('sitemap_inconsistency')
  check('sitemap_inconsistency: at least 2 findings', sitemap.length >= 2)
  check(
    'sitemap_inconsistency: caught sitemap_url_404 for /broken',
    sitemap.some((f) =>
      f.targetUrl === 'https://tarino.au/broken' &&
      (f.detail as { kind: string }).kind === 'sitemap_url_404',
    ),
  )
  check(
    'sitemap_inconsistency: caught missing_from_sitemap for /orphan',
    sitemap.some((f) =>
      f.targetUrl === 'https://tarino.au/orphan' &&
      (f.detail as { kind: string }).kind === 'missing_from_sitemap',
    ),
  )

  // ── duplicate_titles ──
  const dupTitles = get('duplicate_titles')
  check('duplicate_titles: detected', dupTitles.length === 1)  // ONE finding covering 3 pages
  check(
    'duplicate_titles: detail.page_count = 3',
    (dupTitles[0]?.detail as { page_count: number })?.page_count === 3,
  )
  check(
    'duplicate_titles: severity P1 (3-9 pages)',
    dupTitles[0]?.severity === 'P1',
  )

  // ── duplicate_meta_descriptions ──
  // All default pages have the same meta_description, so this should fire.
  const dupMeta = get('duplicate_meta_descriptions')
  check('duplicate_meta_descriptions: detected', dupMeta.length >= 1)
  check(
    'duplicate_meta_descriptions: detail.page_count > 3',
    (dupMeta[0]?.detail as { page_count: number })?.page_count > 3,
  )

  // ── Delta pass smoke test ──
  console.log('\n--- delta pass ---')
  const now = new Date()
  const prior = new Map<string, ResolvedFinding>()
  // Inject one fake prior finding so we get a 'persistent' transition
  prior.set('missing_h1::https://tarino.au/no-h1', {
    id:           'pre-existing-finding-id',
    checkName:    'missing_h1',
    findingKey:   'missing_h1::https://tarino.au/no-h1',
    targetUrl:    'https://tarino.au/no-h1',
    relatedUrl:   null,
    severity:     'P1',
    state:        'new',
    firstSeenAt:  new Date('2026-05-09T12:00:00Z'),  // 7 days ago — would escalate after 3 weeks
    lastSeenAt:   new Date('2026-05-09T12:00:00Z'),
    weeksOpen:    1,
    detail:       {},
  })
  // Inject a prior finding that won't appear this audit → should resolve
  prior.set('missing_h1::https://tarino.au/gone', {
    id:           'gone-finding-id',
    checkName:    'missing_h1',
    findingKey:   'missing_h1::https://tarino.au/gone',
    targetUrl:    'https://tarino.au/gone',
    relatedUrl:   null,
    severity:     'P1',
    state:        'persistent',
    firstSeenAt:  new Date('2026-05-01T12:00:00Z'),
    lastSeenAt:   new Date('2026-05-09T12:00:00Z'),
    weeksOpen:    2,
    detail:       {},
  })

  const { findings: resolved, resolvedIds } = computeDelta({ current: findings, prior, now })

  const persistent = resolved.find((f) => f.findingKey === 'missing_h1::https://tarino.au/no-h1')
  check('delta: pre-existing finding marked persistent', persistent?.state === 'persistent')
  check('delta: persistent finding weeks_open incremented', persistent?.weeksOpen === 2)
  check(
    'delta: removed finding identified as resolved',
    resolvedIds.some((r) => r.findingKey === 'missing_h1::https://tarino.au/gone'),
  )
  check(
    'delta: new findings marked new',
    resolved.filter((f) => f.state === 'new').length > 0,
  )

  // ── Nav heuristic ──
  console.log('\n--- nav heuristic ---')
  // Build a synthetic case where /about gets linked from >50% of pages.
  const navPages = Array.from({ length: 10 }, (_, i) =>
    makePage({ url: `https://example.com/p${i}` }),
  )
  const navLinks: InternalLink[] = navPages.map((p) =>
    makeLink(p.url, 'https://example.com/about'),
  )
  navLinks.push(
    makeLink('https://example.com/p0', 'https://example.com/some-orphan'),
  )
  const upgraded = applyNavHeuristic(navLinks, navPages)
  check(
    'nav-heuristic: /about linked from all 10 pages → isNav=true',
    upgraded.filter((l) => l.targetUrl === 'https://example.com/about').every((l) => l.isNav),
  )
  check(
    'nav-heuristic: /some-orphan linked from only 1 page → isNav unchanged',
    upgraded.find((l) => l.targetUrl === 'https://example.com/some-orphan')?.isNav === false,
  )

  // ── Wrap ──
  console.log()
  if (failed) {
    console.log(`${RED}${failed} assertion(s) failed${RESET}`)
    process.exit(1)
  }
  console.log(`${GREEN}All auditor smoke tests passed.${RESET}`)
})()
