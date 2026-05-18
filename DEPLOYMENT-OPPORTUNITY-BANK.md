# DEPLOYMENT — Opportunity Bank Foundation

**The biggest bundle since SEO-2.** Establishes the unified opportunity catalogue + state machine + selection algorithm, hooks it into the daily run, ad-hoc Slack flow, and HITL reject path. Future discovery skills (SEO-3/4/5) plug in by filing typed opportunities; the daily run consumes them automatically.

## What this bundle does

| Capability | Where |
|---|---|
| New schema columns + indexes | `db/migrations/opportunity-bank.ts` (registered in `db/migrate.ts`) |
| Opportunity row types, scoring constants | `src/core/opportunity-bank/types.ts` |
| Bank selection (`pickForDailyRun`, `pickForAdHoc`) with diversity cap | `src/core/opportunity-bank/select.ts` |
| Atomic state transitions | `src/core/opportunity-bank/transitions.ts` |
| Reshape-on-reject (LLM-driven, flat-rejection detection, lineage depth cap) | `src/core/opportunity-bank/reshape.ts` |
| Ad-hoc prompt → opportunity-type classifier | `src/core/opportunity-bank/ad-hoc-match.ts` |
| Smoke test (pure-function tests for scoring, diversity, flat detection) | `scripts/smoke-opportunity-bank.ts` |
| Daily run pulls from bank | `src/orchestrator/aggregator.ts` — patched |
| Ad-hoc Slack checks bank before fresh discovery | `src/tenants/slackManager.ts` — patched |
| HITL reject hook calls reshape-or-dismiss | `src/hitl/handlers.ts` — patched |

**Effort:** ~30 minutes including migration + verification.
**Risk:** Medium. New code path is opt-in (bank surfaces only if there are 'new' rows; ad-hoc check only triggers on opportunity-typed prompts; reshape only triggers on bank-linked approvals). Backward compatible — existing opportunities, runs, approvals continue working unchanged. **One real concern**: migration hits the shared dev/prod DB.

---

## Design recap

**Schema:** `seo_opportunities` gets columns for `surfaced_in_run_id`, `surfaced_at`, `dismissed_reason`, `reshape_source_id`, `reshape_target_id`, `reshape_count`. Status CHECK widened to include `'surfaced'`. `approval_requests` gets `opportunity_id` for the bank link.

**Status lifecycle:**
```
new → surfaced → queued → in_progress → executed*
              ├ rejected*  (reshape_target_id may point at a new 'new' row)
              └ stale*       (aged out)
```
Three terminal states (`*`).

**Selection algorithm:** priority weight (P0=10, P1=6, P2=3) × age boost (fresher = higher) → sort → diversity cap at 2 per type → top N. Atomic transition `new → surfaced` with `surfaced_in_run_id` stamped.

**Reshape decision:** rejection reason null/empty/short-and-dismissive → terminal. Otherwise → LLM call producing refined variant, capped at 3 reshape iterations per lineage.

**Daily run integration:** before the aggregator LLM call (only on `cron-daily` trigger), call `pickForDailyRun()`. Append the surfaced rows to the aggregator's `differentialBlock`. LLM is instructed to include them in `newOpportunities`. The specialist agent's existing inline discovery continues to run as fallback / supplementary discovery.

**Ad-hoc integration:** before `enqueueTask`, classify the prompt against known opportunity types. If high-confidence match AND bank has ≥3 matching rows → serve from bank, skip fresh discovery. Otherwise fall through.

**HITL reject integration:** existing reject handler unchanged; one new line hooks `handleRejectionOnOpportunity` which looks up the bank link and either reshapes or terminally rejects.

---

## Chunk 1 — Apply

Unzip the bundle into the repo root — you need BOTH `wire-opportunity-bank.js` AND the `files/` directory next to each other:

```bash
cd ~/Projects/CGSAgent/agent-shell-v3
cp ~/Downloads/wire-opportunity-bank.js .
cp -r ~/Downloads/files .
node wire-opportunity-bank.js
```

**Expected output:**
```
✓ Created db/migrations/opportunity-bank.ts
✓ Created src/core/opportunity-bank/types.ts
✓ Created src/core/opportunity-bank/select.ts
✓ Created src/core/opportunity-bank/transitions.ts
✓ Created src/core/opportunity-bank/reshape.ts
✓ Created src/core/opportunity-bank/ad-hoc-match.ts
✓ Created src/core/opportunity-bank/index.ts
✓ Created scripts/smoke-opportunity-bank.ts
✓ Patched db/migrate.ts
✓ Patched src/orchestrator/aggregator.ts
✓ Patched src/tenants/slackManager.ts
✓ Patched src/hitl/handlers.ts
```

If any anchor isn't found, paste the error and stop.

---

## Chunk 2 — Type-check

```bash
npx tsc --noEmit
```

Must exit clean. Anything that prints, paste back.

---

## Chunk 3 — Run the migration

This is the one that hits the shared dev/prod DB. Backward compatible — only adds columns and widens a CHECK — but it's the real production database, so worth doing eyes-open.

```bash
npm run db:migrate
```

Expected: no errors. The migration is idempotent and only adds columns / indexes / a relaxed constraint. Existing rows are unchanged.

**Quick verification:**

```sql
\d seo_opportunities
-- Should now show surfaced_in_run_id, surfaced_at, dismissed_reason,
-- reshape_source_id, reshape_target_id, reshape_count columns.

\d approval_requests
-- Should now show opportunity_id column.

SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'seo_opportunities_status_check';
-- Should include 'surfaced' in the IN list.
```

---

## Chunk 4 — Run the smoke test

Pure-function tests only — no DB or network needed.

```bash
npx tsx scripts/smoke-opportunity-bank.ts
```

**Expected:**
```
✓ priority ordering: P0 > P1 > P2
✓ diversity cap at 2 per type
✓ cap respected on dominant type
✓ overflow drops the lowest-scored same-type
✓ limit caps total picks
✓ fresh P1 outranks aged-out P0
✓ empty input returns empty
✓ null reason is flat
✓ empty string is flat
✓ whitespace-only is flat
✓ "no" alone is flat
✓ "never" is flat
✓ "nope" is flat
✓ "not relevant" is flat
✓ substantive feedback is not flat
✓ medium-length real feedback is not flat
✓ long reason with "no" inside is not flat

all checks passed
```

If you want it wired into npm, add to `package.json`:
```json
"smoke:opportunity-bank": "tsx scripts/smoke-opportunity-bank.ts"
```

---

## Chunk 5 — Eyeball the patches

```bash
git status
git diff db/migrate.ts src/orchestrator/aggregator.ts src/tenants/slackManager.ts src/hitl/handlers.ts
```

Expected diffs:

| File | Lines added |
|---|---|
| `db/migrate.ts` | 2 lines (import + call) |
| `src/orchestrator/aggregator.ts` | ~26 lines (import + cron-daily bank-surface block) |
| `src/tenants/slackManager.ts` | ~40 lines (import + ad-hoc bank check) |
| `src/hitl/handlers.ts` | ~9 lines (import + reshape hook) |

Plus a bunch of `Untracked files` for the new modules.

---

## Chunk 6 — Commit and merge

```bash
git checkout -b feat/opportunity-bank-foundation
git add db/migrate.ts db/migrations/opportunity-bank.ts \
        src/core/opportunity-bank/ \
        src/orchestrator/aggregator.ts \
        src/tenants/slackManager.ts \
        src/hitl/handlers.ts \
        scripts/smoke-opportunity-bank.ts
git commit -m "feat: opportunity-bank foundation — selection, state machine, reshape-on-reject"
git push -u origin feat/opportunity-bank-foundation
git checkout main
git pull origin main
git merge feat/opportunity-bank-foundation
git push origin main
```

`wire-opportunity-bank.js` and the `files/` directory are intentionally NOT added — they're build intermediates.

---

## Chunk 7 — Watch the deploy

```bash
gcloud builds list --limit=1 --project=YOUR_PROJECT_ID
gcloud run services logs tail cgs-agent-shell --region us-central1
```

Normal startup. No new env vars, no new secrets.

---

## Chunk 8 — Live verification

**Daily run path** (Mon/Wed/Fri 8am AEST). After the next daily fires, look for:

```bash
gcloud run services logs tail cgs-agent-shell --region us-central1 \
  | grep -E "aggregator_surfaced_from_bank|aggregator_bank_surface_failed"
```

- If you see `aggregator_surfaced_from_bank` with `count > 0` — the bank is working
- If you see `count: 0` or no log line — bank was empty (expected at first; only the audit currently files opportunities)
- If you see `aggregator_bank_surface_failed` — something errored; check the err string

**Ad-hoc bank check path.** Mention the Tarino bot with an opportunity-related prompt:

```
@TarinoBot find me pages with missing meta descriptions
```

Watch logs:
```
adhoc_served_from_bank   (if ≥3 matching rows existed)
adhoc_bank_too_thin_falling_through  (if <3, falls through to normal agent flow)
adhoc_bank_check_failed  (if classifier or DB query errored — falls through too)
```

In Slack you should either see the bank pull (formatted list of opportunities) or the normal "Got it, starting agent" response.

**Reshape path.** Next time you reject an approval in the modal with substantive feedback (>15 chars OR not a dismissive keyword), look for:

```
opportunity_reshaped    (if approval was bank-linked and reshape succeeded)
opportunity_rejected_terminal  (if flat rejection or reshape_count hit cap)
```

A reshaped opportunity creates a new row with `reshape_source_id` set; it'll re-enter the bank for the next daily run.

**Quick DB check after a daily run:**
```sql
-- New surfaced rows from today's run
SELECT id, type, priority, surfaced_in_run_id, surfaced_at
FROM seo_opportunities
WHERE tenant_id = 'tarino'
  AND status = 'surfaced'
  AND surfaced_at > NOW() - INTERVAL '4 hours'
ORDER BY surfaced_at DESC;

-- Reshape lineages
SELECT
  o.id, o.type, o.reshape_count,
  o.reshape_source_id, o.reshape_target_id
FROM seo_opportunities o
WHERE o.tenant_id = 'tarino'
  AND (o.reshape_source_id IS NOT NULL OR o.reshape_target_id IS NOT NULL);
```

---

## Chunk 9 — Cleanup

```bash
rm -rf wire-opportunity-bank.js files/
git branch -d feat/opportunity-bank-foundation
```

---

## What "done" looks like

- [ ] `node wire-opportunity-bank.js` reports 8 `Created` + 4 `Patched`
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run db:migrate` runs without errors
- [ ] `npx tsx scripts/smoke-opportunity-bank.ts` passes all checks
- [ ] `\d seo_opportunities` shows the new columns
- [ ] Commit pushed to `main`, Cloud Build succeeds
- [ ] Cloud Run logs show clean startup of new revision
- [ ] First daily run after deploy: `aggregator_surfaced_from_bank` log line appears (with count 0 OR ≥1 depending on whether audit filed anything fresh)
- [ ] An ad-hoc Slack mention with opportunity-related text either serves from bank or falls through cleanly

---

## What this unlocks

With this foundation in place, each SEO-3 / SEO-4 / SEO-5 rollout becomes substantially smaller:

- The **discovery skill** for that rollout files opportunities to `seo_opportunities` with `status='new'` and a meaningful `type`
- The **type goes into `KNOWN_OPPORTUNITY_TYPES`** in `ad-hoc-match.ts` (one-line addition)
- The **daily run picks them up automatically** — no aggregator changes needed
- The **ad-hoc Slack flow finds them automatically** — no slackManager changes needed
- The **reshape feedback loop works automatically** — no HITL changes needed

The hard part — the customer-facing layer — is now shared.
