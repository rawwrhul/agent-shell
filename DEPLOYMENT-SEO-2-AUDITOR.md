# SEO-2 Technical SEO Auditor — Deployment Guide

> Adds nine deterministic SEO checks, persistent finding tracking, and grouped opportunity generation. Wires a `seo_audit` cron that runs crawl + audit weekly at Saturday midnight Sydney time, feeding the next Monday's daily run.
>
> Prerequisites: **SEO-1 Crawler must already be deployed** (this guide assumes `seo_crawl_runs`, `seo_page_inventory`, and `seo_internal_links` already exist).
>
> Total estimated time: **20–30 minutes** end-to-end (most of it is verification).

---

## Files in this bundle

```
sql/
  20260516-seo-2-auditor.sql         — pure SQL version of the migration
db/migrations/
  seo-2-auditor.ts                   — TS migration, called from db/migrate.ts
src/skills/seo-technical-auditor/
  SKILL.md                           — rules of engagement
  types.ts                           — Finding, AuditRun, severity, state
  index.ts                           — runAudit + runFullAuditCycle entrypoints
  store.ts                           — DB layer (audit_runs, findings, opportunities)
  delta.ts                           — new/persistent/resolved/ignored state transitions
  synthesis.ts                       — LLM call that groups findings into opportunities
  nav-heuristic.ts                   — >50% rule that catches Framer-style global nav
  sitemap.ts                         — sitemap.xml fetcher (with nested-index support)
  checks/
    util.ts                          — shared helpers (finding-key, indexable)
    broken-internal-links.ts
    orphan-pages.ts
    missing-meta-description.ts
    missing-h1.ts
    multiple-h1.ts
    canonical-conflicts.ts
    sitemap-inconsistency.ts
    duplicate-titles.ts
    duplicate-meta-descriptions.ts
    index.ts                         — ALL_CHECKS barrel
src/cli/
  audit.ts                           — `npm run audit <tenantId> [--cycle]`
scripts/
  smoke-auditor-checks.ts            — 32-assertion smoke test, no DB needed
wire-seo-2.js                        — patch script for the 4 existing-file edits
DEPLOYMENT-SEO-2-AUDITOR.md          — this file
```

---

## Step 1 — Drop files into the repo

From the bundle root:

```bash
cp -r sql/* ~/Projects/CGSAgent/agent-shell-v3/sql/
cp -r db/* ~/Projects/CGSAgent/agent-shell-v3/db/
cp -r src/* ~/Projects/CGSAgent/agent-shell-v3/src/
cp -r scripts/* ~/Projects/CGSAgent/agent-shell-v3/scripts/
cp wire-seo-2.js ~/Projects/CGSAgent/agent-shell-v3/
```

No new dependencies. No `npm install` needed.

## Step 2 — Wire the integrations

```bash
cd ~/Projects/CGSAgent/agent-shell-v3
node wire-seo-2.js
```

Expected output:

```
Editing src/scheduler/types.ts
  RunKind: extended
Editing src/scheduler/worker.ts
  worker.ts: wired (import + seo_audit fork)
Editing src/scheduler/config.ts
  config.ts: wired (DEFAULT_SCHEDULES + applyDefaultSchedulesFor)
Editing db/migrate.ts
  migrate.ts: wired (import + call)

All edits applied.
```

The patch script is **idempotent** — running it twice is safe (each edit re-prints `already applied`).

The four edits:

| File | Change |
|---|---|
| `src/scheduler/types.ts` | Adds `'seo_audit'` to the `RunKind` union |
| `src/scheduler/worker.ts` | Imports `runFullAuditCycle` and adds an early-return branch for `runKind === 'seo_audit'` that calls the cycle directly (bypasses the orchestrator) |
| `src/scheduler/config.ts` | Adds `DEFAULT_SCHEDULES.seo_audit = { cronExpr: '0 0 * * 6', timezone: 'Australia/Sydney' }` and registers it in `applyDefaultSchedulesFor` |
| `db/migrate.ts` | Imports and calls `runSeo2AuditorMigration` after `runSeo1CrawlerMigration` |

## Step 3 — Run the smoke test

Pure-TypeScript, no DB, no network:

```bash
npx tsx scripts/smoke-auditor-checks.ts
```

Expected: **All auditor smoke tests passed.** (32 assertions)

Add to `package.json` for convenience:

```bash
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.scripts = p.scripts || {};
p.scripts.audit = 'tsx src/cli/audit.ts';
p.scripts['smoke:auditor'] = 'tsx scripts/smoke-auditor-checks.ts';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log('package.json updated');
"
```

## Step 4 — Typecheck

```bash
npx tsc --noEmit
```

Should pass silently. If anything errors, stop here — don't run the migration or push.

## Step 5 — Run the migration

```bash
npm run db:migrate
```

Expected output (the relevant tail):

```
✅ All migrations complete
```

Verify the schema changes:

```bash
psql "$DATABASE_URL" -c "\d seo_audit_runs"
psql "$DATABASE_URL" -c "\d seo_audit_findings"
psql "$DATABASE_URL" -c "SELECT column_name FROM information_schema.columns WHERE table_name='seo_opportunities' AND column_name='source_finding_id'"
psql "$DATABASE_URL" -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'tenant_schedules'::regclass AND contype = 'c'"
```

The last query should return a CHECK definition that includes `'seo_audit'`.

## Step 6 — Register Tarino's audit schedule

`applyDefaultSchedulesFor` only runs on **new** tenant onboarding — Tarino's already in the DB, so we register manually:

```bash
psql "$DATABASE_URL" -c "
INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES ('tarino', 'seo_audit', '0 0 * * 6', 'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind) DO UPDATE SET
  cron_expr = EXCLUDED.cron_expr,
  timezone  = EXCLUDED.timezone,
  enabled   = EXCLUDED.enabled;
"
```

Confirm:

```bash
psql "$DATABASE_URL" -c "SELECT tenant_id, run_kind, cron_expr, timezone, enabled FROM tenant_schedules WHERE tenant_id='tarino'"
```

You should see three rows: `daily`, `seo_audit`, and possibly `weekly` (which is deprecated and filtered at bootstrap).

## Step 7 — Local test (audit-only, no crawl)

Tarino already has crawl data from the SEO-1 deploy. Run the audit against it:

```bash
npm run audit tarino
```

Expected output structure:

```
→ Auditing tarino (against existing crawl data)

✅ Audit completed in ~5–15s
   Audit run ID:  <uuid>
   Findings:      <N> total
     New:         <N>     ← first audit, all are new
     Persistent:  0
     Resolved:    0
   Severities:    P0=0  P1=<N>  P2=<N>  P3=<N>
   Opportunities: <0-7>

─── Audit narrative ───
[Audit 2026-05-16] <plain-English summary of the technical state>
```

**What you should see for Tarino specifically (based on the SEO-1 crawl finding):**
- A `duplicate_titles` finding covering ~24 pages — severity P0 (because count ≥10)
- An `orphan_page` finding for ~5 pages (the same 5 the crawler flagged), possibly fewer if the nav heuristic correctly re-classifies Framer's footer links as global nav and re-counts inbound links
- A `missing_h1` finding for 1 page (matches crawler output)
- A `missing_meta_description` finding for 1 page (matches crawler output)
- 1–3 opportunities synthesizing the above (one will be "Fix duplicate page titles across 24 pages")

## Step 8 — Verify the writes

```bash
psql "$DATABASE_URL" -c "
SELECT id, started_at, completed_at, findings_total, findings_new,
       opportunities_created, LEFT(narrative, 80) AS narrative_preview
  FROM seo_audit_runs WHERE tenant_id='tarino' ORDER BY started_at DESC LIMIT 1;
"

psql "$DATABASE_URL" -c "
SELECT check_name, severity, state, target_url
  FROM seo_audit_findings WHERE tenant_id='tarino'
  ORDER BY severity, check_name LIMIT 20;
"

psql "$DATABASE_URL" -c "
SELECT priority, type, target, LEFT(description, 80) AS description_preview
  FROM seo_opportunities WHERE tenant_id='tarino' AND status='new'
  ORDER BY priority LIMIT 10;
"

psql "$DATABASE_URL" -c "
SELECT key, type, LEFT(value::text, 200) AS value_preview, updated_at
  FROM tenant_memory WHERE tenant_id='tarino' AND key='audit-summary';
"
```

The `audit-summary` row should exist and contain a 4–8 sentence narrative.

## Step 9 — (Optional) Test the full cycle

```bash
npm run audit tarino --cycle
```

This will:
1. Run a fresh crawl (~30–60s)
2. Run the audit against the new crawl data (~5–15s)
3. Write `site-inventory` + `audit-summary` memory entries

Use this to verify the cron-driven path works end-to-end. **The second audit is also when delta-detection becomes meaningful** — findings from audit #1 that recur in audit #2 should now show as `persistent` with `weeks_open=2`.

```bash
psql "$DATABASE_URL" -c "
SELECT state, COUNT(*) FROM seo_audit_findings
  WHERE tenant_id='tarino' GROUP BY state;
"
```

You should see a mix of `new` and `persistent` (and `resolved` if anything got fixed between crawls).

## Step 10 — Commit & deploy

```bash
git checkout -b feat/seo-2-auditor
git add .
git commit -m "feat(seo-2): technical SEO auditor — 9 deterministic checks + delta tracking + grouped opportunities + Saturday-midnight cron"
git push origin feat/seo-2-auditor
git checkout main
git merge feat/seo-2-auditor
git push origin main   # triggers Cloud Build
```

After Cloud Run picks up the new revision, watch:

```bash
gcloud run services logs tail cgs-agent-shell --region us-central1 | \
  grep -E "seo_audit_cycle|audit_run|schedule_register"
```

You should see `schedule_register` for `tarino__seo_audit` on bootstrap. The actual audit cycle won't fire until Saturday midnight Sydney time.

---

## Operational notes

### Manually triggering the audit cron in production

If you want to verify the cron path in prod without waiting for Saturday:

```bash
psql "$DATABASE_URL" -c "
UPDATE tenant_schedules
   SET cron_expr = '*/5 * * * *'    -- every 5 minutes for testing
 WHERE tenant_id='tarino' AND run_kind='seo_audit';
"
```

Watch Cloud Run logs for `seo_audit_cycle_starting` → `seo_audit_cycle_completed`. Then **restore the original cron**:

```bash
psql "$DATABASE_URL" -c "
UPDATE tenant_schedules
   SET cron_expr = '0 0 * * 6'
 WHERE tenant_id='tarino' AND run_kind='seo_audit';
"
```

Note: the scheduler's bootstrap reconciles repeatable jobs against the DB on startup, so the change won't take effect until the next deploy (or until you manually delete the BullMQ repeatable). For a quick sanity test, just run `npm run audit tarino --cycle` locally instead — it exercises the same `runFullAuditCycle` function the cron does.

### Marking a finding as "ignored"

The auditor will keep re-flagging the same issue every Saturday unless the operator either fixes it or marks it ignored:

```sql
UPDATE seo_audit_findings
   SET state = 'ignored',
       ignored_reason = 'Intentional — footer-only link, low-priority page'
 WHERE id = '<finding-uuid>';
```

Ignored findings are preserved across audits, excluded from synthesis, and never auto-resolve. To un-ignore, set the state back to `'persistent'`.

### When duplicate_titles drops to 0 (the Tarino test case)

Once you ship the Framer per-page-title fix from `tarino-framer-fix-guide.pdf` and re-audit:

- The `duplicate_titles` finding (audit_run_id from the prior audit) gets marked `resolved`
- `seo_audit_runs.findings_resolved` increments
- The narrative should mention the resolution explicitly

This is the natural end-to-end test for delta-detection. If it doesn't happen, check: (a) is the same crawl seeing the new titles? (b) is the prior duplicate_titles finding actually present in the DB?

### Cost expectations per audit

- Crawl phase: 0 LLM tokens (deterministic)
- Check phase: 0 LLM tokens (deterministic)
- Synthesis phase: ~3000–6000 input tokens, ~800–2000 output tokens (Sonnet 4.5)

A typical Tarino-scale audit (25 pages, ~10 findings) costs roughly **$0.02–0.05** per audit. Monthly cost at one audit per week per tenant: under $0.30/tenant.

---

## Rollback

If something goes wrong post-deploy:

```bash
# Disable the cron for tarino — stops further audits without removing data
psql "$DATABASE_URL" -c "
UPDATE tenant_schedules SET enabled=false
 WHERE tenant_id='tarino' AND run_kind='seo_audit';
"
```

The audit tables and opportunities they wrote are independent of the rest of the system — leaving them in the DB is safe. If you need to clear them:

```sql
DELETE FROM seo_audit_findings WHERE tenant_id='tarino';
DELETE FROM seo_audit_runs     WHERE tenant_id='tarino';
DELETE FROM seo_opportunities  WHERE tenant_id='tarino' AND source_finding_id IS NOT NULL;
```

The schema additions (`source_finding_id` column, extended `tenant_schedules` CHECK) are forward-compatible — no rollback needed for the migration itself.

---

## Known constraints

1. **Delta tracking needs ≥2 audits.** First audit's findings are all `new`. The interesting transitions appear from audit #2 onward.
2. **JS-rendered titles invisible.** The crawler reads static HTML; Framer's per-page titles only become visible after JS hydration. Until SEO-3 adds a render-fetcher, sites built on JS-first platforms will show duplicate-title findings that reflect the pre-hydration state. This is honest reporting of what crawlers see, but worth flagging to clients on Framer/Webflow/Wix.
3. **Synthesis priority cap.** The synthesis layer can't promote a finding above its check-declared severity. If a P2 finding becomes business-critical, the operator should edit the resulting opportunity's `priority` field directly in `seo_opportunities`.
