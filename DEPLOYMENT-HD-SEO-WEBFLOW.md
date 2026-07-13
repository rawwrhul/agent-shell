# DEPLOYMENT — hd-seo (High Demand Electrical, Webflow, full autonomy)

Second autonomous SEO tenant, first on Webflow. New tenant `hd-seo` —
separate from the existing `hd-electrician` quoting tenant (one agent_type
per tenant). Full Tarino package: 2 articles/day, 10-14 actions/day, all
quality gates, outcome loop, daily digest.

## What was built

**Webflow integration (`src/integrations/webflow/`)** — ground-up, Data API
v2, no SDK. `client.ts`: per-tenant site token from `integration_credentials`
(integration='webflow'), site id from `tenants.webflow_site_id`, blog
collection + field mapping resolved dynamically from the collection schema
(matched by slug/name patterns, cached 10 min). `tools.ts`: four read tools
(site info, list/get blog items, list pages). `executor.ts`: nine executors.

**THE WEBFLOW RULE — verify-after-write.** Webflow PATCHes can return 200
and silently not persist (observed in production with image alt text). Every
executor re-reads after writing and compares; a write that didn't stick
returns `ok:false` with `webflow_silent_write_failure`. No silent successes.

**Executor surface (mirrors framer_*):** `webflow_confirm_publish`,
`webflow_rollback_draft`, `webflow_update_blog_meta`, `webflow_update_blog_body`,
`webflow_add_blog_alt_text`, `webflow_add_internal_link`,
`webflow_update_marketing_page_text`, plus one Framer can't do:
**`webflow_update_page_meta`** — static/service page SEO title+description
via API. On a 50-service-page local site this is the biggest on-page lever,
and it's fully autonomous instead of a manual task.

**CMS routing.** `approve_blog_pitch` in the dispatcher routes by tenant:
integrations containing 'webflow' → Webflow draft + `webflow_confirm_publish`
Stage 2 (same Surfer gate, same discard-and-retry, same auto-approve);
otherwise the original Framer path. Webflow tool names added to: pipeline-events
Stage-2 check, outcome-scoring SLUG_TOOLS, daily-digest URL builder, edit-gate
tool sets (suffix-matched), render actionKind mapping, autonomy (dispatcher
registration makes them auto-executable; denylist unchanged).

**Prompts are now CMS-aware.** `subagent.ts` daily-generation playbook and
`scheduler/worker.ts` run prompts derive tool names, path prefix, domain, and
manual-task boundaries from the tenant (also removed the hardcoded
Tarino/tarino.au references — they now come from tenant config).

## Activation runbook (operator steps, in order)

1. **Slack app** for hd-seo: create app + channel, store secrets in GCP
   Secret Manager as `hd-seo-slack-bot-token`, `hd-seo-slack-app-token`,
   `hd-seo-slack-signing-secret`.
2. **Push + migrate**: push to main, wait green, `npm run db:migrate`
   (adds `webflow_site_id`).
3. **Register tenant**: `npm run onboard` → tenant_id `hd-seo`, agent type
   `seo-loop`, skills `["seo"]`, the hd Slack channel, business brief
   (ASP Level 2 electrician, Sydney, emergency/switchboard/EV/metering lanes,
   300+ five-star reviews, licence 397193C), competitor domains.
4. **Webflow credential**:
   `npx tsx scripts/set-credential.ts hd-seo webflow "<site token>"`
5. **GSC**: grant the CGS service account access to the
   hdlevel2electriciansydney.com.au Search Console property.
6. **Supabase SQL**: `sql/20260713-hd-seo-activation.sql` (fill in
   `<WEBFLOW_SITE_ID>` first). Sets integrations, domain, prefix,
   autonomy=full, and the full 12-schedule cadence (staggered 15-45 min
   off Tarino's).
7. **Restart** (empty-commit push) so the scheduler registers the schedules.

## Smoke test before first cron (strongly recommended)

The Webflow write path has never touched production. Before 08:15 the next
morning, run one supervised end-to-end check from the repo:

```
npx tsx -e "import 'dotenv/config'; const { getTenant } = await import('./src/tenants/registry.ts'); const wf = await import('./src/integrations/webflow/client.ts'); const t = await getTenant('hd-seo'); console.log(await wf.getSiteInfo(t)); console.log(await wf.resolveBlogFields(t)); const items = await wf.listBlogItems(t, 5); console.log(items.map(i => i.fieldData.slug)); process.exit(0)"
```

This proves: token valid, site id right, blog collection found, field mapping
resolved (check `bodyField`/`imageField`/`metaDescField` are non-null — if the
collection's field names are unusual the pattern matching may need one tweak
in `resolveBlogFields`).

## Verify after first day

- `surfer_autonomous_quality_gate` with `cms: 'webflow'` in Cloud Run logs.
- `webflow_silent_write_failure` count — should be zero; any occurrence is
  the footgun firing and needs a look at which field/endpoint.
- Articles live at hdlevel2electriciansydney.com.au/resources/…
- `daily_digests` row for hd-seo at 17:15.
- No cross-tenant weirdness in Tarino's runs (shared worker, staggered crons).

## Known limits / first-fortnight expectations

- Outcome loop, protect-winners, cannibalization keyword-overlap: blind until
  `metrics_sync` accrues ranking_history (all fail open). Real verdicts ~2
  weeks after actions start shipping.
- Site-wide schema on Webflow routes to manual_operator_task (custom-code API
  deliberately out of v1 scope).
- Webflow Pages DOM API (marketing page text) is the least battle-tested
  endpoint — if `webflow_update_marketing_page_text` verification fails
  repeatedly, expect a response-shape tweak in `getPageDom`/node parsing.
- `webflow_update_page_meta` publishes the whole site (Webflow requirement
  for static-page changes) — unlike CMS item publishes, this WILL bundle any
  unpublished designer changes the client has sitting in Webflow. If the
  client actively edits their site in Webflow, coordinate or drop this tool
  to manual.

## Verification (local)

`npx tsc --noEmit` fully clean (ads chunk landed, zero errors repo-wide);
`npx vitest run` 213/213 → plus webflow client tests. See commit for counts.
