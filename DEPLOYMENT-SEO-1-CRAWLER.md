# SEO Rollout 1 — Crawler & Fetcher

Adds a polite, throttled site crawler that populates three new tables:
`seo_page_inventory`, `seo_internal_links`, `seo_crawl_runs`. Builds a
queryable internal-link graph for orphan detection, broken-link discovery,
and downstream technical SEO audits.

**Branch:** `feat/seo-1-crawler`
**Bundle:** 9 new files + 2 modified files + 1 SQL migration + 2 new deps
**Migrations:** 1 (`runSeo1CrawlerMigration` — idempotent)
**New dependencies:** `cheerio`, `robots-parser`

---

## What's in this rollout

### New code (9 files)

| # | File | Purpose |
|---|------|---------|
| 1 | `src/core/crawler/types.ts` | Shared types: `CrawlConfig`, `ParsedPage`, `ExtractedLink`, `CrawlSummary`. |
| 2 | `src/core/crawler/fetcher.ts` | Polite HTTP fetcher with timeout, single retry on 5xx/network errors, content-type gating, throttle-on-return. |
| 3 | `src/core/crawler/robots.ts` | Per-host robots.txt cache (6h TTL) + `isAllowed()` + `getCrawlDelay()`. Conservative: missing robots.txt → allow all. |
| 4 | `src/core/crawler/parser.ts` | Cheerio-based HTML → ParsedPage. Extracts every SEO signal `analyze_page` does, plus the internal-link graph with anchor text + nav flags. SHA-256 content hash for cheap change detection. |
| 5 | `src/core/crawler/crawler.ts` | BFS orchestrator. Honours robots, depth + page caps, dedup, host gating. Records progress every 25 pages so a long crawl stays observable. |
| 6 | `src/core/crawler/store.ts` | DB layer. Lifecycle for `seo_crawl_runs`, upsert for `seo_page_inventory`, atomic replace-by-source for `seo_internal_links`. Plus 6 read functions for the tools. |
| 7 | `src/core/crawler/tools.ts` | 6 agent-callable read tools: `crawl_summary`, `query_pages`, `find_orphans`, `find_broken_internal_links`, `get_inbound_links`, `latest_crawl_status`. |
| 8 | `src/core/crawler/index.ts` | Barrel export. |
| 9 | `src/cli/crawl.ts` | Manual CLI: `npm run crawl <tenantId> [--max-pages N] [--depth N] [--no-robots] [--seed URL]`. Prints summary + orphans + broken links to stdout. |

### New DB migration (2 files — same content)

| # | File | What it does |
|---|------|--------------|
| 10 | `sql/20260516-seo-1-crawler.sql` | Canonical SQL for the three tables. Idempotent. |
| 11 | `db/migrations/seo-1-crawler.ts` | TS migration function called from `db/migrate.ts`. Runs equivalent SQL in a transaction. |

### Smoke test

| # | File | What it does |
|---|------|--------------|
| 12 | `scripts/smoke-crawler-parser.ts` | Synthetic-HTML smoke test for the parser. 28 assertions. Doesn't touch network or DB. Run with `npm run smoke:crawler`. |

### Modified files (2)

| File | Change |
|------|--------|
| `db/migrate.ts` | Import + call `runSeo1CrawlerMigration` after the existing R3/Phase8 calls. |
| `package.json` | Add `cheerio` + `robots-parser` to dependencies. Add `crawl` and `smoke:crawler` to scripts. |

---

## What this enables

Three things become possible after this lands:

1. **Site-wide analysis instead of page-at-a-time.** `analyze_page` is great for one URL; the crawler gives you 200–500 of them at once and the relationships between them. The agent can ask "which pages have no inbound non-nav links" and get an answer in 50ms instead of doing it iteratively across many tool calls.

2. **Internal-link graph as queryable data.** The graph lives in `seo_internal_links` as adjacency rows (source, target, anchor, is_nav). Standard SQL handles orphan detection, anchor-text distribution, link-equity reasoning, hub-and-spoke validation.

3. **Change detection over time.** Each crawl upserts `seo_page_inventory` with a SHA-256 content hash. Two consecutive crawls give you the set of pages whose content changed, which is the foundation for the next rollout's "what regressed this week" delta.

This rollout does NOT add a Technical Auditor specialist — that's SEO-2. What ships here is the data layer + tools so SEO-2 can be a thin LLM layer on top.

---

## Cost notes

- **Per crawl:** zero LLM tokens (this is pure deterministic plumbing).
- **Bandwidth:** ~1MB per page on average. 500-page crawl = ~500MB egress, runs in 4–6 minutes at default throttle.
- **DB:** rows are small. 500 pages × ~50 links = 25k link rows; multiply by all tenants by all weeks. Even at 50 tenants × 52 weeks × 30k rows that's ~80M rows in a year — Postgres handles that with the existing indexes, but worth knowing.
- **Memory:** the crawler keeps two `Set<string>` (visited + enqueued) in memory. 500 pages × ~100-char URLs = ~100KB. Negligible.

---

## Pre-flight check

```bash
git fetch origin
git checkout main
git pull origin main
git status        # should be clean
git checkout -b feat/seo-1-crawler
```

You'll need the **target_domain** column populated for whichever tenant
you smoke-test against. For Tarino:

```sql
SELECT tenant_id, target_domain FROM tenants WHERE tenant_id = 'tarino';
```

If `target_domain` is NULL, set it before running the crawler — the CLI
refuses to run without it.

---

## Step 1 — Drop the new files in

Unzip the bundle into the repo root. It only adds files; nothing is
clobbered. Verify:

```bash
ls src/core/crawler/
# crawler.ts  fetcher.ts  index.ts  parser.ts  robots.ts  store.ts  tools.ts  types.ts
ls src/cli/crawl.ts
ls scripts/smoke-crawler-parser.ts
ls sql/20260516-seo-1-crawler.sql
ls db/migrations/seo-1-crawler.ts
```

---

## Step 2 — Install the new deps

```bash
npm install cheerio robots-parser
```

Then verify your `package.json` `dependencies` block now includes:

```json
"cheerio":       "^1.0.0",
"robots-parser": "^3.0.1",
```

Add these two scripts under `scripts`:

```json
"crawl":         "tsx src/cli/crawl.ts",
"smoke:crawler": "tsx scripts/smoke-crawler-parser.ts"
```

---

## Step 3 — Wire the migration into `db/migrate.ts`

Open `db/migrate.ts`. At the top, after the other migration imports:

```ts
import { runSeo1CrawlerMigration } from './migrations/seo-1-crawler'
```

Then near the bottom of the `migrate()` function, before the
`console.log('✅ All migrations complete')` line, add:

```ts
await runSeo1CrawlerMigration(pool)
```

So the bottom of the function looks like:

```ts
  await runR3Migration(pool)
  await runPhase8Migration(pool)
  await runSeo1CrawlerMigration(pool)   // ← new

  console.log('✅ All migrations complete')
  await pool.end()
}
```

---

## Step 4 — Local smoke check

Run the parser smoke test first — no network or DB needed:

```bash
npm run smoke:crawler
```

You should see 28 green ticks and "All parser smoke tests passed." If any
fail, **stop and investigate** — the parser is the heart of the rollout
and any failure here means link-graph correctness is suspect.

Then typecheck the whole repo:

```bash
npm run typecheck
```

Should be clean.

---

## Step 5 — Run the migration (dev DB first)

If you have a separate dev DB, run there first:

```bash
DATABASE_URL=<dev-conn-string> npm run db:migrate
```

Expected output:

```
Running CGS Agent Shell v3 migrations…
✅ All migrations complete
```

Then verify the tables exist in the dev DB:

```sql
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name LIKE 'seo_crawl%' OR table_name LIKE 'seo_page%' OR table_name LIKE 'seo_internal%';
-- Expected: seo_crawl_runs, seo_internal_links, seo_page_inventory
```

---

## Step 6 — Smoke crawl against your own tenant

For Tarino (or whichever tenant you're testing with):

```bash
DATABASE_URL=<dev-conn-string> npm run crawl tarino -- --max-pages 50 --depth 4
```

Why 50 pages first: it's enough to validate behaviour without committing
a 5-minute crawl while you're iterating. Bump to 500 once you trust the
output.

Expected stdout (abbreviated):

```
→ Crawling tarino (https://tarino.au)
  Seeds: https://tarino.au/, https://tarino.au/sitemap.xml
  Limits: maxPages=50, maxDepth=4, throttle=500ms
  Robots: respected

✅ Crawl completed in 38.4s
   Pages crawled: 47
   Pages failed:  1
   Pages skipped: 3

   Sample pages:
     [200] https://tarino.au/  — Tarino — Filipino comfort food
     [200] https://tarino.au/menu  — Menu — Tarino
     [200] https://tarino.au/resources/  — Stories — Tarino
     [200] https://tarino.au/resources/post-name  — ...
     [200] https://tarino.au/about  — About Tarino

─── Inventory stats ───
   Total pages:       47
   Status breakdown:  {"2xx":46,"4xx":1}
   Missing H1:        3
   Missing meta desc: 8
   Noindex pages:     0
   Orphaned pages:    2
   Internal edges:    312
```

Then sanity-check the DB:

```sql
SELECT COUNT(*) FROM seo_page_inventory WHERE tenant_id = 'tarino';
-- ~47

SELECT COUNT(*) FROM seo_internal_links WHERE tenant_id = 'tarino';
-- ~300+

SELECT status, pages_crawled, pages_failed, started_at, completed_at
  FROM seo_crawl_runs
 WHERE tenant_id = 'tarino'
 ORDER BY started_at DESC LIMIT 1;
```

---

## Step 7 — Verify the tools work from the agent surface

The tools are registered as `CRAWLER_TOOLS` in `src/core/crawler/tools.ts`
but aren't yet wired into the subagent's toolbelt. To make them
available to the SEO specialist, edit `src/agents/subagent.ts`:

Find the imports near the top and add:

```ts
import {
  CRAWLER_TOOLS, executeCrawlerTool, isCrawlerToolName,
} from '../core/crawler'
```

Then find `buildToolsForSpecialist` (or wherever SEO tools are conditionally
added — search for `SEO_TOOLS`) and add `CRAWLER_TOOLS` to the same branch
that gates SEO tools. They're read-only so they're safe in both
`investigate` and `propose_changes` task intents.

In the tool dispatch loop, find the `isSeoToolName` branch and add a sibling:

```ts
if (isCrawlerToolName(name)) {
  return await executeCrawlerTool(name, input, tenant)
}
```

Quick check that the tools are reachable from a real specialist:

```
@<bot-name> run a quick check using crawl_summary
```

You should see the agent call `crawl_summary` and report the stats from
Step 6 back into Slack.

---

## Step 8 — Production

Once dev is happy:

```bash
git add .
git commit -m "feat(seo-1): polite crawler + page_inventory + link graph"
git push origin feat/seo-1-crawler

# After PR + review:
git checkout main
git merge feat/seo-1-crawler
git push origin main
```

The Cloud Build trigger picks up from there. Watch the build, then once
Cloud Run is live:

```bash
gcloud run services logs tail cgs-agent-shell --region us-central1 \
  | grep -i crawler
```

You should see nothing initially (no crawls have been scheduled yet — that
comes with SEO-2). To trigger a production crawl manually, run the CLI
locally against the production `DATABASE_URL`:

```bash
DATABASE_URL=<prod-conn-string> npm run crawl tarino
```

Or open a one-shot Cloud Run job — but for a single manual smoke crawl, the
local CLI is faster.

---

## Step 9 — Verify behaviour against tarino.au

Pull the SEO skill's `SKILL.md` requirement: "Always pass the pinned
`target_domain` from the tenant config when crawling — never guess." The
CLI enforces this — if `tenants.target_domain` is unset, it refuses to
run. Verify:

```sql
UPDATE tenants SET target_domain = NULL WHERE tenant_id = 'tarino';  -- DEV ONLY
```

```bash
npm run crawl tarino
# Expected: error and exit 1
```

```sql
UPDATE tenants SET target_domain = 'https://tarino.au' WHERE tenant_id = 'tarino';
```

```bash
npm run crawl tarino -- --max-pages 20
# Expected: succeeds
```

---

## Rollback

The migration is purely additive — three new tables and their indexes.
Rolling back the code is git-revert + redeploy. If you want the tables
gone too:

```sql
BEGIN;
DROP TABLE IF EXISTS seo_internal_links;
DROP TABLE IF EXISTS seo_page_inventory;
DROP TABLE IF EXISTS seo_crawl_runs;
COMMIT;
```

But there's no reason to — they're empty until the crawler writes, and
they don't affect any existing query path.

---

## Known limitations

These are deliberately out of scope for v1. Document them, don't fix
them now:

1. **JS-rendered sites.** The parser sees the un-rendered HTML. For pages
   that build their nav in React/Vue/etc., outbound links visible only
   after hydration won't be detected, and those pages will look orphaned.
   Per-tenant fix when needed: add a render-fetcher (Playwright or
   ScrapingBee) as a per-tenant `respect_render` flag.

2. **No cancellation token.** Long crawls run to completion. Cloud Run
   will SIGTERM after `terminationGracePeriodSeconds` (default 10s) which
   will kill the crawl mid-page. Last `updateCrawlRunProgress` checkpoint
   (every 25 pages) preserves what was crawled; the rest is lost.
   Adequate for v1.

3. **No incremental crawl.** Every run starts from seeds. `crawlKind`
   exists in the schema for future use but `'full'` and `'delta'` behave
   identically today. Real delta crawls (only re-fetch pages whose
   content_hash might have changed) need a content-modified signal we
   don't have without GSC, so this is parked.

4. **`is_nav` is heuristic.** Anything inside `<nav>`, `<header>`, or
   `<footer>` is flagged. Sites that don't use semantic HTML (links in
   `<div class="navigation">`) will mis-flag. The downstream consumer
   (orphan detection) defaults to excluding nav links from inbound
   counts; if a tenant's nav lives in a `<div>`, orphan reports will be
   noisy. Per-tenant CSS-selector override is a v2 add.

5. **No per-host concurrency.** A single crawl is serial. If we add
   competitor crawls (SEO-4) that span multiple hosts, those CAN run in
   parallel — but a single tenant's own crawl stays one-at-a-time so we
   stay polite.

---

## What this unblocks

| Future rollout | How it consumes this layer |
|---|---|
| SEO-2 Technical Auditor | Reads `seo_page_inventory` + `seo_internal_links`; runs delta checks against the previous crawl. Doesn't crawl itself — schedules a crawl, then runs checks. |
| SEO-4 Competitor Tracker | Reuses `runCrawl()` with a different `tenantId` namespace (`tenantId='competitor:<domain>:<owner-tenant>'` or similar — design at SEO-4 time). |
| ROADMAP Rollout 2 Snapshotter | The crawler already writes content hashes; that's half of the snapshot shape. Wiring the rest is a small addition once the snapshot tables exist. |
