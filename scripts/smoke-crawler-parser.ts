// scripts/smoke-crawler-parser.ts
//
// Stand-alone smoke test for the parser. Doesn't touch the network or DB —
// feeds synthetic HTML through parsePage() and asserts the obvious fields.
//
// Run: tsx scripts/smoke-crawler-parser.ts
// Or:  npm run smoke:crawler

import { parsePage } from '../src/core/crawler/parser'

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

// ── Case 1: well-formed page with everything ──────────────────────────────
{
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <base href="https://example.com/">
  <title>About Tarino — Filipino comfort food in Sydney</title>
  <meta name="description" content="A family-run Filipino restaurant in Sydney's inner west. Open Tue–Sun.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://example.com/about">
  <meta property="og:image" content="https://example.com/img/hero.jpg">
  <script type="application/ld+json">
  { "@context":"https://schema.org", "@type":"Restaurant", "name":"Tarino" }
  </script>
</head>
<body>
  <header><nav><a href="/">Home</a> <a href="/menu">Menu</a></nav></header>
  <main>
    <h1>About us</h1>
    <p>We're a family-run kitchen. Read our <a href="/story">story</a>
       or browse the <a href="/menu" rel="nofollow">menu</a>.</p>
    <img src="/img/team.jpg" alt="Our team in the kitchen">
    <img src="/img/decor.jpg">
    <a href="https://external.com/feature" rel="noopener">Press feature</a>
  </main>
  <footer><a href="/contact">Contact</a></footer>
</body>
</html>`
  const r = parsePage({
    url:         'https://example.com/about',
    finalUrl:    'https://example.com/about',
    httpStatus:  200,
    contentType: 'text/html; charset=utf-8',
    body:        html,
  })

  check('case1: title extracted',          r.title === 'About Tarino — Filipino comfort food in Sydney')
  check('case1: meta desc extracted',      (r.metaDescription ?? '').startsWith('A family-run'))
  check('case1: canonical absolute',       r.canonicalUrl === 'https://example.com/about')
  check('case1: language set',             r.language === 'en')
  check('case1: og:image extracted',       r.ogImage === 'https://example.com/img/hero.jpg')
  check('case1: 1 H1 found',               r.h1Count === 1 && r.h1First === 'About us')
  check('case1: schema type captured',     r.schemaTypes.includes('Restaurant'))
  check('case1: image alt counted',        r.imageCount === 2 && r.imagesWithAlt === 1 && r.imagesMissingAlt === 1)
  check('case1: 5 internal links resolved + deduped',
    r.links.filter((l) => l.isInternal).length === 5,
    `got ${r.links.filter((l) => l.isInternal).length}`,
  )
  check('case1: 1 external link',          r.externalLinkCount === 1)
  check('case1: nav links flagged',        r.links.find((l) => l.target.endsWith('/menu') && !l.target.includes('rel'))?.isNav === true)
  check('case1: rel attribute preserved',  r.links.some((l) => l.rel?.includes('nofollow')))
  check('case1: word count > 0',           r.wordCount > 0)
  check('case1: content hash set',         r.contentHash !== null && r.contentHash.length === 64)
}

// ── Case 2: missing tags / SPA-ish minimal markup ─────────────────────────
{
  const html = `<html><body><div id="root"></div></body></html>`
  const r = parsePage({
    url: 'https://example.com/app', finalUrl: 'https://example.com/app',
    httpStatus: 200, contentType: 'text/html', body: html,
  })
  check('case2: no title surfaces as null', r.title === null)
  check('case2: no h1 → count 0',           r.h1Count === 0)
  check('case2: no meta desc → null',       r.metaDescription === null)
  check('case2: no canonical → null',       r.canonicalUrl === null)
  check('case2: no schema types → empty',   r.schemaTypes.length === 0)
  check('case2: no links → empty',          r.links.length === 0)
}

// ── Case 3: relative URLs, base href edge cases ───────────────────────────
{
  const html = `<html><head><base href="https://example.com/blog/"></head>
<body>
  <a href="post-a">A</a>
  <a href="../about">About</a>
  <a href="https://example.com/menu">Menu</a>
  <a href="//cdn.example.com/asset.js">CDN</a>
  <a href="#section">Anchor only</a>
  <a href="mailto:hi@example.com">Email</a>
</body></html>`
  const r = parsePage({
    url: 'https://example.com/blog/index', finalUrl: 'https://example.com/blog/index',
    httpStatus: 200, contentType: 'text/html', body: html,
  })
  const targets = r.links.map((l) => l.target).sort()
  check('case3: skips fragments and mailto', !targets.some((t) => t.startsWith('mailto:') || t.endsWith('#section')))
  check('case3: relative resolved with base', targets.includes('https://example.com/blog/post-a'))
  check('case3: parent-relative resolved',    targets.includes('https://example.com/about'))
  check('case3: protocol-relative resolved',  targets.some((t) => t.startsWith('https://cdn.example.com/')))
  check('case3: absolute internal preserved', targets.includes('https://example.com/menu'))
}

// ── Case 4: noindex via meta robots ───────────────────────────────────────
{
  const html = `<html><head>
  <meta name="robots" content="NOINDEX, nofollow">
  <title>Hidden</title>
</head><body><h1>Hidden</h1></body></html>`
  const r = parsePage({
    url: 'https://example.com/hidden', finalUrl: 'https://example.com/hidden',
    httpStatus: 200, contentType: 'text/html', body: html,
  })
  check('case4: meta robots captured',  (r.metaRobots ?? '').toLowerCase().includes('noindex'))
}

// ── Case 5: JSON-LD with @graph nesting ───────────────────────────────────
{
  const html = `<html><head>
  <script type="application/ld+json">
  { "@context":"https://schema.org",
    "@graph":[
      { "@type":"Organization", "name":"Tarino" },
      { "@type":"WebSite",      "name":"tarino.au" },
      { "@type":["LocalBusiness","Restaurant"], "name":"Tarino" }
    ]}
  </script>
</head><body></body></html>`
  const r = parsePage({
    url: 'https://example.com/', finalUrl: 'https://example.com/',
    httpStatus: 200, contentType: 'text/html', body: html,
  })
  check('case5: @graph traversed', r.schemaTypes.includes('Organization') && r.schemaTypes.includes('WebSite'))
  check('case5: array @type expanded', r.schemaTypes.includes('LocalBusiness') && r.schemaTypes.includes('Restaurant'))
}

console.log()
if (failed) {
  console.log(`${RED}${failed} assertion(s) failed${RESET}`)
  process.exit(1)
}
console.log(`${GREEN}All parser smoke tests passed.${RESET}`)
