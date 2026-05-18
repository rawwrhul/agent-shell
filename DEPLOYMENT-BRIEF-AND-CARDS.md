# DEPLOYMENT — Business Brief + Unified Approval Cards

Two structural fixes shipped as one bundle:

1. **`tenants.business_brief`** — operator-authored grounding text, injected into outreach drafter, daily aggregator system prompt, and specialist system prompts. Eliminates the "LLM guesses industry from name" failure mode.
2. **Unified approval cards** — every bank-surfaced opportunity now gets its own `approval_requests` row with type-appropriate body. The aggregator's anchor message renderer already inlines pending approvals as Block Kit action buttons — so each card appears with Approve/Reject/Defer buttons inline in the daily run post.

Plus a `tenants.operator_slack_user_id` so the cards can `@mention` you on Slack.

## What landed

| Capability | Where |
|---|---|
| Schema: `tenants.business_brief`, `tenants.operator_slack_user_id` | `db/migrations/business-brief-and-cards.ts` |
| TenantConfig fields + row mapping | `src/tenants/types.ts`, `src/tenants/registry.ts` |
| Outreach drafter accepts + injects businessBrief | `src/core/outreach-drafter/index.ts` |
| Backlink prospector + mention monitor pass it through | `src/skills/seo-*/index.ts` |
| Aggregator daily system prompt prepends businessBrief | `src/orchestrator/aggregator.ts` |
| Specialist system prompt prepends businessBrief | `src/agents/subagent.ts` |
| Card builder dispatches per opportunity type | `src/core/opportunity-bank/card-builder.ts` |
| Aggregator creates cards after `pickForDailyRun` | `src/orchestrator/aggregator.ts` |
| HITL handler marks outreach as sent on approve | `src/hitl/handlers.ts` |
| AUTO_EXECUTE_TYPES set (empty for v1) | `src/core/opportunity-bank/card-builder.ts` |

**Effort:** ~30 minutes including post-deploy SQL setup.

---

## Apply

```bash
cd ~/Projects/CGSAgent/agent-shell-v3
unzip -o ~/Downloads/brief-and-cards-bundle.zip
node wire-brief-and-cards.js
```

Expected: 3 `Created` + 9 `Patched`.

## Type-check

```bash
npx tsc --noEmit
```

Anything that prints, paste back.

## Migration

```bash
npm run db:migrate
```

Two new columns on `tenants`, both nullable. No changes to existing data.

## Smoke test

```bash
npx tsx scripts/smoke-brief-and-cards.ts
```

## Commit + merge

```bash
git checkout -b feat/business-brief-and-approval-cards
git add db/migrate.ts \
        db/migrations/business-brief-and-cards.ts \
        src/tenants/types.ts \
        src/tenants/registry.ts \
        src/core/outreach-drafter/index.ts \
        src/core/opportunity-bank/card-builder.ts \
        src/skills/seo-backlink-prospector/index.ts \
        src/skills/seo-brand-mention-monitor/index.ts \
        src/orchestrator/aggregator.ts \
        src/agents/subagent.ts \
        src/hitl/handlers.ts \
        scripts/smoke-brief-and-cards.ts
git commit -m "feat: business_brief grounding + unified approval cards for bank-surfaced opportunities"
git push -u origin feat/business-brief-and-approval-cards
git checkout main
git pull origin main
git merge feat/business-brief-and-approval-cards
git push origin main
```

---

## Post-deploy: populate Tarino's business_brief + operator user ID

This is the step that actually activates everything. Two values to set:

### 1. Get your Slack user ID

In Slack:
- Open your profile (click your avatar top-right → View profile)
- Click the **`⋮`** (more options) → **Copy member ID**
- It'll be a string like `U07A1B2C3DE`

### 2. Run the SQL

Use `psql` or Supabase SQL editor. Drafted business_brief based on tarino.au's current site copy — edit if you want to tighten:

```sql
UPDATE tenants
SET
  business_brief = $$Tarino is a direct-hire offshore recruitment service for Australian professional services firms (accounting, legal, consulting, financial advisory). The pricing model is a one-off $5,000 + GST placement fee on hire — no ongoing salary markups, no monthly margin, no setup fees. The company is positioned against incumbent outsourcing agencies (TOA Global, Hammerjack, Staff Domain, Beepo) that charge monthly markups on top of staff salaries. Offshore talent is Philippines-based, working Australian hours. Tarino's screening process emphasises video screens, practical tasks, structured scorecards, and independent background checks. Replacement cover is 6 months. Target customers are Australian small-to-mid professional services firms that want to scale without locking themselves into perpetual outsourcing margins.$$,
  operator_slack_user_id = 'U07A1B2C3DE'   -- ← REPLACE WITH YOUR ACTUAL SLACK USER ID
WHERE tenant_id = 'tarino';
```

Verify:

```sql
SELECT
  tenant_id,
  LEFT(business_brief, 100) AS brief_preview,
  operator_slack_user_id
FROM tenants
WHERE tenant_id = 'tarino';
```

Should print a brief preview + your Slack user ID.

**Cache note:** `TenantConfig` is cached for 5 minutes per the resolver. After SQL update, next tenant load fetches fresh values. To force-refresh now, either restart the Cloud Run service or wait 5 min.

```bash
gcloud run services update cgs-agent-shell --region us-central1 --no-traffic \
  && gcloud run services update-traffic cgs-agent-shell --to-latest --region us-central1
```

---

## Live verification — full E2E

### Test 1: Brief injection in outreach drafts

```bash
# Re-fire backlink_prospect to generate new drafts with the brief
cat > scripts/refire-backlink.ts << 'EOF'
import { enqueueOneOffRun } from '../src/scheduler'
;(async () => {
  await enqueueOneOffRun({ tenantId: 'tarino', runKind: 'backlink_prospect' })
  console.log('queued')
  process.exit(0)
})()
EOF
npx tsx scripts/refire-backlink.ts

# Wait 2-3 min, then inspect the new draft
```

```sql
SELECT detail->>'drafted_subject', detail->>'drafted_body'
FROM seo_opportunities
WHERE tenant_id = 'tarino' AND type = 'pursue_backlink'
ORDER BY created_at DESC LIMIT 1;
```

**Expected:** the body talks about offshore recruitment, professional services, placement fees, or direct-hire model. Zero food/restaurant references. If you see any food/menu/dining language, the brief isn't injecting — paste back and we debug.

### Test 2: Approval cards on next daily run

Trigger a daily run manually (this one IS customer-facing, so know it'll post to Tarino's channel):

```bash
cat > scripts/refire-daily.ts << 'EOF'
import { enqueueOneOffRun } from '../src/scheduler'
;(async () => {
  await enqueueOneOffRun({ tenantId: 'tarino', runKind: 'daily' })
  console.log('queued daily')
  process.exit(0)
})()
EOF
npx tsx scripts/refire-daily.ts
```

Watch in Tarino's Slack channel. You should see:
- A run anchor message
- Each surfaced opportunity inlined with Approve/Reject/Defer action buttons
- The riskReason text on outreach cards includes the drafted email body + mailto + tags `<@your-user-id>`

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="cgs-agent-shell" AND "approval_cards_for_surfaced_complete"' \
  --limit=5 --freshness=20m \
  --format='value(timestamp,jsonPayload.message,jsonPayload.cardsCreated,jsonPayload.errorCount)' \
  --project=cgs-agent-shell-495221
```

You should see `cardsCreated > 0` and `errorCount = 0`.

### Test 3: Approve an outreach card

Click Approve on a backlink card in Slack. Then verify:

```sql
SELECT
  o.id, o.type, o.status,
  q.status AS queue_status, q.sent_at
FROM seo_opportunities o
LEFT JOIN seo.outreach_queue q ON q.opportunity_id = o.id
JOIN approval_requests a ON a.opportunity_id = o.id
WHERE a.tool_name = 'outreach_send_mailto'
  AND a.status = 'approved'
ORDER BY a.updated_at DESC LIMIT 1;
```

Should show: `opportunity.status='executed'`, `queue_status='sent'`, `sent_at` populated.

### Test 4: Reject an outreach card with substantive feedback

Click Reject, provide a reason like "wrong target — they only cover enterprise, not SMBs." Then:

```sql
SELECT id, type, status, reshape_source_id, reshape_count, description
FROM seo_opportunities
WHERE reshape_source_id IS NOT NULL
  AND tenant_id = 'tarino'
ORDER BY created_at DESC LIMIT 1;
```

Should show a new descendant opportunity in `status='new'`, with `reshape_count=1` and a refined description addressing the SMB feedback. It'll surface in the next daily run.

---

## Known caveats

1. **AUTO_EXECUTE_TYPES is empty.** No types currently auto-execute. Every surfaced opportunity gets a card. When you decide a type IS safe to auto-execute (e.g. internal cache refresh, recompute scoring), add it to the `AUTO_EXECUTE_TYPES` set in `card-builder.ts` and add the dispatch logic.

2. **Daily-send cap is soft on approve.** If you approve an outreach when you're already at 20/day, the approval still resolves and the queue row is marked sent — but a warning logs. v1 trade-off; switch to "block + defer" if you want hard enforcement.

3. **Brief is not injected into audit-synthesis prompt yet.** The audit synthesizer LLM still doesn't know what Tarino does. It produces finding text like "page has no internal links" which is type-aware but not industry-aware. Low risk for now (synthesis output is internal-facing rationale, not customer copy) — flag for a follow-up patch if synthesis prose feels off.

4. **No bulk-approve.** A run that surfaces 7 cards = 7 Approve clicks. Worth considering "approve all audit fixes" later but not v1.

## What this unblocks

- SEO-5 outreach is now end-to-end actionable from Slack (was DB-only before this).
- All audit findings filed to the bank get cards on next daily run.
- Future SEO-3 / SEO-4 discovery skills inherit cards for free — they just file opportunities, the system handles the rest.
- The drafter, aggregator, and specialist all now work from grounded industry context.

## Cleanup

```bash
rm -rf wire-brief-and-cards.js files/
git branch -d feat/business-brief-and-approval-cards
```
