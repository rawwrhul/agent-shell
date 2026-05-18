# DEPLOYMENT — SEO-5 Backlinks (Phase 1 MVP)

Builds on the opportunity-bank foundation. Two new weekly background discovery cycles file `pursue_backlink` and `fix_unlinked_mention` opportunities; the daily run already surfaces them via `pickForDailyRun`. Approvals show a drafted email + recipient placeholder + mailto link.

## Phase 1 scope (this bundle)

| Capability | Where |
|---|---|
| Tables: `seo.backlink_inventory`, `seo.brand_mentions`, `seo.outreach_queue` | `db/migrations/seo-5-backlinks.ts` |
| `tenants.disabled_opportunity_types` opt-out column | same |
| `seo_opportunities.detail` JSONB for rich type-specific payload | same |
| `dataforseo.backlinksList` — actual backlink rows (not just summary) | `src/integrations/dataforseo/client.ts` |
| Spam-safety: per-prospect uniqueness, 60-day cool-off, 20/day cap | `src/core/outreach-safety/` |
| LLM-driven outreach drafter (5 prospect types, type-specific framing) | `src/core/outreach-drafter/` |
| Weekly backlink prospector (Sun 02:00 AEST) | `src/skills/seo-backlink-prospector/` |
| Weekly brand mention monitor (Sun 04:00 AEST) | `src/skills/seo-brand-mention-monitor/` |
| Cron simulator extended to accept runKind argument | `src/tenants/slackManager.ts` — patched |
| TenantConfig resolver maps `targetDomain`, `competitorDomains`, opt-outs | `src/tenants/registry.ts` — patched |
| Smoke test (drafter framing regression + caps constants) | `scripts/smoke-seo-5.ts` |

## Explicitly **not** in Phase 1 (future)

- Toxic / spammy backlink detection + disavow flagging
- Lost-backlink recovery
- HARO sourcing
- Partnership prospects
- Slack "mark replied" button
- Hunter.io / automated contact discovery

The opt-out column is in place so phase-2 types just need code, not schema work.

---

## Apply

```bash
cd ~/Projects/CGSAgent/agent-shell-v3
unzip -o ~/Downloads/seo-5-backlinks-bundle.zip
node wire-seo-5-backlinks.js
```

Expected: 10 `Created` + 8 `Patched`. If any anchor fails, paste the error.

## Type-check

```bash
npx tsc --noEmit
```

Anything that prints, paste back. Most likely issue: tsc strictness on `tenant` narrowing inside the prospector's try-catch — easy to fix by adding `let tenant: TenantConfig` annotation if it complains.

## Migration

```bash
npm run db:migrate
```

Shared dev/prod DB. Additive only:
- 3 new tables in `seo.` schema
- `tenants.disabled_opportunity_types` column (default `'{}'`)
- `seo_opportunities.detail` JSONB column

Quick check:
```sql
\d seo.backlink_inventory
\d seo.brand_mentions
\d seo.outreach_queue
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'tenants'
    AND column_name IN ('disabled_opportunity_types', 'competitor_domains', 'target_domain');
```

## Smoke test

```bash
npx tsx scripts/smoke-seo-5.ts
```

Should print 11 green checks (TYPE_FRAMING regression + cap constants).

## Eyeball

```bash
git status
git diff db/migrate.ts \
        src/integrations/dataforseo/client.ts \
        src/tenants/types.ts \
        src/tenants/registry.ts \
        src/scheduler/types.ts \
        src/scheduler/worker.ts \
        src/scheduler/config.ts \
        src/tenants/slackManager.ts
```

## Ship

```bash
git checkout -b feat/seo-5-backlinks-phase-1
git add db/migrate.ts \
        db/migrations/seo-5-backlinks.ts \
        src/integrations/dataforseo/client.ts \
        src/core/outreach-safety/ \
        src/core/outreach-drafter/ \
        src/skills/seo-backlink-prospector/ \
        src/skills/seo-brand-mention-monitor/ \
        src/tenants/types.ts \
        src/tenants/registry.ts \
        src/scheduler/types.ts \
        src/scheduler/worker.ts \
        src/scheduler/config.ts \
        src/tenants/slackManager.ts \
        scripts/smoke-seo-5.ts
git commit -m "feat: SEO-5 backlinks phase 1 — prospector + mention monitor + outreach drafter"
git push -u origin feat/seo-5-backlinks-phase-1
git checkout main
git pull origin main
git merge feat/seo-5-backlinks-phase-1
git push origin main
```

## After deploy — manual cron-trigger to validate

You don't have to wait until Sunday. Mention the bot:

```
@TarinoBot secretchrontest backlink
```

then watch:
```bash
gcloud run services logs tail cgs-agent-shell --region us-central1 \
  | grep -E "backlink_prospect_cycle"
```

Expected log progression (assuming Tarino has at least one competitor in `tenants.competitor_domains`):
```
adhoc_audit_trigger_received   {... runKind: backlink_prospect}
backlink_prospect_cycle_starting_from_worker
backlink_prospect_cycle_starting
(some inventory + gap logs)
backlink_prospect_cycle_completed
backlink_prospect_cycle_completed_from_worker
```

If Tarino has no competitors configured:
```
backlink_gap_no_competitors_configured
```
→ add them via SQL:
```sql
UPDATE tenants
SET competitor_domains = ARRAY['competitor1.com', 'competitor2.com']
WHERE tenant_id = 'tarino';
```

For brand mentions:
```
@TarinoBot secretchrontest mention
```
→ `brand_mention_scan_cycle_*` logs.

## After the next daily run

The next Mon/Wed/Fri 8am will pull these new opportunities from the bank. Look for:

```bash
gcloud run services logs tail cgs-agent-shell --region us-central1 \
  | grep aggregator_surfaced_from_bank
```

The count should be higher than before (it now includes pursue_backlink + fix_unlinked_mention rows alongside audit findings).

## DB check after first cycle

```sql
-- Backlink prospects we filed
SELECT
  o.id, o.priority, o.target, o.description,
  o.detail->>'source_domain' AS source_domain,
  o.detail->>'source_dr' AS source_dr,
  q.status AS queue_status,
  (o.detail->>'drafted_subject') IS NOT NULL AS has_draft
FROM seo_opportunities o
LEFT JOIN seo.outreach_queue q ON q.opportunity_id = o.id
WHERE o.tenant_id = 'tarino'
  AND o.type = 'pursue_backlink'
ORDER BY o.created_at DESC
LIMIT 20;

-- Brand mentions
SELECT
  o.id, o.priority, o.target, o.description,
  o.detail->>'source_url' AS source_url
FROM seo_opportunities o
WHERE o.tenant_id = 'tarino'
  AND o.type = 'fix_unlinked_mention'
ORDER BY o.created_at DESC
LIMIT 20;

-- Outreach queue state
SELECT prospect_type, status, COUNT(*)
FROM seo.outreach_queue
WHERE tenant_id = 'tarino'
GROUP BY prospect_type, status;
```

## Operator workflow (once an opportunity surfaces in Slack)

1. Daily run posts to Slack with a `pursue_backlink` opportunity in the list.
2. Operator clicks the approval — the approval card shows the drafted email body + a `mailto:RECIPIENT_EMAIL?...` link.
3. Operator finds the real contact email (from the target site's contact page, or LinkedIn, or wherever). Pastes it into the Approvals sheet next to the draft.
4. Operator clicks the `mailto:` link with `RECIPIENT_EMAIL` replaced — opens default mail client pre-populated.
5. Operator sends from their inbox.
6. Operator clicks **Approve** on the Slack card — this marks the `outreach_queue` row as `sent` and triggers the daily-send-cap check (blocks if already at 20/day).

For MVP, reply tracking is manual — if a reply comes in, the operator can update `outreach_queue.status = 'replied'` directly. Phase 2 will add a Slack button for this.

## Verification checklist

- [ ] `node wire-seo-5-backlinks.js` reports 10 `Created` + 8 `Patched`
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run db:migrate` succeeds; new tables present
- [ ] `npx tsx scripts/smoke-seo-5.ts` — 11 green
- [ ] `@bot secretchrontest backlink` triggers — logs show `backlink_prospect_cycle_completed`
- [ ] `@bot secretchrontest mention` triggers — logs show `brand_mention_scan_cycle_completed`
- [ ] After the next daily run, `aggregator_surfaced_from_bank` includes backlink/mention opportunities
- [ ] First approval card shows drafted email + mailto link + recipient placeholder

## Known caveats

1. **DataForSEO backlinks endpoint response shape.** I built against the documented `/v3/backlinks/backlinks/live` schema; if the actual response differs from `items[]`, the first run will log `backlink_inventory_fetch_failed` and you'll want to inspect the raw response and adjust `BacklinkListItem` in `client.ts`. Verifiable by adding `console.log(JSON.stringify(rows.slice(0, 1), null, 2))` in `inventory.ts` if needed.

2. **Cost.** Each backlink prospect cycle costs ~$0.50-2 in DataForSEO API + LLM draft calls (one LLM call per prospect filed, capped at 15/cycle). Brand mention scan costs ~$0.30-0.50 in SERP queries + 10 LLM draft calls. Weekly cadence keeps total tenant cost in single digits/week.

3. **`disabled_opportunity_types`** is a TEXT[]; populate via direct SQL when needed:
   ```sql
   UPDATE tenants SET disabled_opportunity_types = ARRAY['fix_unlinked_mention']
   WHERE tenant_id = 'tarino';
   ```

## Cleanup

```bash
rm -rf wire-seo-5-backlinks.js files/
git branch -d feat/seo-5-backlinks-phase-1
```
