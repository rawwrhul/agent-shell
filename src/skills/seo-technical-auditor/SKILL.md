---
name: seo-technical-auditor
description: Deterministic technical SEO audit. Runs nine rule-based checks against the latest crawl inventory, tracks findings across audits, escalates persistent issues, and produces grouped opportunities for the operator to action.
triggers:
  - on cron 'seo_audit' (Saturday midnight Sydney)
  - manual via `npm run audit <tenantId>` or `npm run audit <tenantId> --cycle`
output_consumers:
  - daily-generation run (reads tenant_memory key 'audit-summary' + seo_opportunities)
---

# SEO Technical Auditor

## Rules of engagement

**Checks are deterministic. Synthesis is the only LLM call.** Every finding the auditor surfaces was produced by a rule, not by inference. The LLM only groups findings into opportunities and writes a one-paragraph narrative. If a check fires, it's a fact; if it doesn't, the rule didn't match. Do not infer additional findings from the narrative.

**One audit, one row per logical issue.** Findings have a stable `finding_key` built from `<check_name>::<target_url>::<related_url>`. The same issue (e.g. `/about` linking to a broken `/old-page`) persists as a single row across audits, with its `state`, `weeks_open`, and `last_seen_at` updated each pass. Operators rely on this — a finding's `id` is the address for "ignore this", "open opportunity for this", etc.

**Severities are check-defined, not LLM-defined.** Each check declares the severity it produces. The synthesis layer can only emit opportunities whose priority matches the maximum severity of the included findings — it can't soften a P0 to P1.

**Persistent issues escalate.** Findings that survive three audits get bumped one severity tier (capped at P0). This is the mechanism that surfaces work the operator keeps skipping.

## The nine checks

| Check | Severity | Fires when |
|---|---|---|
| `canonical_conflict` | **P0** | `<link rel="canonical">` points to a 404, forms a canonical chain, or points to an unrelated indexable page |
| `duplicate_titles` | P0 (10+ pages) / P1 (3-9) | Three or more indexable pages share the exact same `<title>` |
| `broken_internal_link` | P1 | An internal link target returned ≥400 or had a fetch error in the latest crawl |
| `sitemap_inconsistency` | P1 (404) / P2 (missing) | A sitemap URL 404s, or an indexable crawled page isn't in the sitemap |
| `missing_meta_description` | P1 (indexable) / P2 (noindex) | Page has no meta description |
| `missing_h1` | P1 (indexable) / P3 (noindex) | Page has zero H1 elements |
| `duplicate_meta_descriptions` | P1 (10+) / P2 (3-9) | Three or more indexable pages share the same meta description |
| `orphan_page` | P2 | Indexable page with zero inbound content links (after nav-heuristic re-classification) |
| `multiple_h1` | P3 | Page has more than one H1 |

## The nav heuristic

The crawler flags `is_nav` using semantic HTML (`<nav>`, `<header>`, `<footer>`). That misses sites built on Framer / Webflow / Wix where nav is rendered inside generic `<div>`s. The auditor adds an in-memory re-pass: **any link target appearing on >50% of crawled pages is treated as nav for orphan-detection purposes, regardless of how the crawler classified it.** This is a per-audit computation that doesn't mutate the underlying `seo_internal_links` table — the crawler's `is_nav` remains as the source of truth from the HTML.

Without this, sites that link `/privacy` only from their footer would have `/privacy` flagged as an orphan on every audit.

## Finding lifecycle

```
        ┌─ first seen ─→ new ─→ (next audit, still present) ─→ persistent ─→ persistent (weeks_open++)
        │                                                       │
operator marks ignored ←────────────────────────────────────────┘
        │
        └─→ ignored (persists across audits, ignored from synthesis, never auto-resolves)

                                                  (not in next audit)
                                          new/persistent ───────────────→ resolved
```

- `new` — finding_key didn't exist in the prior audit
- `persistent` — finding_key existed in prior audit and the check fired again this audit
- `resolved` — finding_key existed in prior audit but the check did NOT fire this audit (issue went away)
- `ignored` — operator-set; preserved across audits, never auto-resolves, excluded from synthesis

A finding can move new → persistent → resolved → new again if the issue recurs. `first_seen_at` records the original detection; `last_seen_at` records the most recent audit where the rule fired.

## Opportunity generation (synthesis)

The synthesis layer (single Anthropic call, Sonnet 4.5, max 4000 tokens) receives all current non-ignored findings and produces:

1. **3–7 opportunity proposals**, each grouping related findings. The store writes these to `seo_opportunities` with `status='new'`, back-linked to the first source finding via `source_finding_id`. **Grouping rules:**
   - One `duplicate_titles` finding covers many pages — that's one opportunity, not many.
   - Multiple `broken_internal_link` findings sharing a common 404'd target collapse into one opportunity.
   - Multiple orphans that a single hub-page link could resolve collapse into one opportunity.
   - Otherwise: one opportunity per distinct issue.

2. **A 4–8 sentence narrative** that gets written to `tenant_memory` under key `audit-summary`. The next daily run loads this as ambient context, so the agent always knows the current technical state of the site.

If the LLM call fails (rate limit, parse error, etc.), synthesis falls back to a degraded output: ungrouped findings sorted by severity become individual opportunities (capped at 5), and the narrative becomes a templated count summary. The audit never fails because of synthesis trouble.

## Priority cap

`seo_opportunities.priority` is constrained to `P0/P1/P2` by an existing CHECK. P3 findings stay in `seo_audit_findings` as informational but never become opportunities (synthesis layer maps P3 → P2 if the LLM tries). P3 findings escalate to P2 after three audits per the persistence rule, at which point they can become opportunities.

## Excluded paths

These URLs never produce `orphan_page` or `missing_from_sitemap` findings:
- `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap.xml.gz`
- `/robots.txt`
- `/favicon.ico`
- `/feed`, `/rss.xml`, `/atom.xml`
- `/.well-known/*`

## Operator controls

Currently DB-level (no admin UI yet):

```sql
-- Mark a finding ignored (persists; won't surface in opportunities or narrative)
UPDATE seo_audit_findings
   SET state = 'ignored', ignored_reason = 'Footer link, intentional'
 WHERE id = '<finding-id>';

-- See all current findings for a tenant, sorted by severity
SELECT severity, check_name, target_url, weeks_open, state
  FROM seo_audit_findings
 WHERE tenant_id = '<id>' AND state IN ('new','persistent')
 ORDER BY severity, weeks_open DESC;

-- See audit history
SELECT id, started_at, completed_at, findings_total, findings_new,
       findings_resolved, opportunities_created
  FROM seo_audit_runs
 WHERE tenant_id = '<id>'
 ORDER BY started_at DESC LIMIT 10;
```

## Sample audit narratives

What the synthesis layer aims to produce (these go to `tenant_memory.audit-summary`):

> [Audit 2026-05-23] 47 active findings (2 P0, 8 P1, 25 P2, 12 P3). The two P0 issues are canonical conflicts on `/products-archived` and `/old-blog-2023`, both pointing to a 404 — these can deindex the source pages and should be fixed first. The largest grouping is 24 indexable pages sharing the title "Offshore Recruitment — Direct Hire, No Markups | Tarino" — Framer per-page SEO needs configuring. Three findings are now in week three of persistence and have been escalated. Nothing was resolved since last week.

> [Audit 2026-05-30] 12 active findings (0 P0, 3 P1, 9 P2). Significant progress: 31 findings resolved since last audit — duplicate-title issue cleared after Framer config fix shipped Monday. Remaining work is dominated by missing meta descriptions on resource pages and three orphan pages in /blog/archive that need internal links from the main blog hub.

## Failure modes

- **No crawl data exists.** `runAudit` exits cleanly with status=completed, findingsTotal=0, and a narrative directing the operator to run a crawl first. No findings or opportunities written.
- **Sitemap unfetchable.** `sitemap_inconsistency` produces zero findings (no false-positives from a missing sitemap). Other checks run normally.
- **Synthesis LLM fails.** Degraded output (ungrouped opportunities, templated narrative). Logged with `audit_synthesis_llm_failed` or `audit_synthesis_parse_failed`.
- **Individual check throws.** Logged with `audit_check_failed` and that check's findings are skipped. Other checks proceed. Audit completes.
- **Tenant has no `target_domain` set.** `runFullAuditCycle` throws before crawling; `runAudit` works fine against existing data.

## Integration points

- **Reads:** `seo_page_inventory`, `seo_internal_links`, `seo_crawl_runs`, `tenants`, `tenant_memory` (key='site-inventory')
- **Writes:** `seo_audit_runs`, `seo_audit_findings`, `seo_opportunities` (new rows only), `tenant_memory` (key='audit-summary')
- **Network:** one GET to `https://<target_domain>/sitemap.xml` per audit (plus nested sitemaps, max 10, capped at 50k URLs total). One Anthropic API call for synthesis.
- **Doesn't touch:** the orchestrator, Slack (audit writes data; the daily run posts), specialist agents, the BullMQ `agent-jobs` queue.
