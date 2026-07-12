# DEPLOYMENT — Tarino autonomous mode

Tenant-level autonomy tier. Tarino moves to `autonomy_level='full'`: no human
approval gate on API-executable actions, 10-14 actions/day including 2
auto-published articles gated by a Surfer quality pipeline. HD Electrician and
all future tenants stay on `'hitl'` — zero behaviour change for them.

## What changed

**Schema (`db/migrations/tenant-autonomy.ts`, registered in `db/migrate.ts`)**
`tenants.autonomy_level TEXT NOT NULL DEFAULT 'hitl'` with CHECK
`('hitl','full')`. `tenant_schedules` run_kind CHECK widened to allow
`'daily_pm'`. Threaded through `TenantRow`/`TenantConfig`/`resolve`
(`src/tenants/types.ts`, `src/tenants/registry.ts`) as `autonomyLevel`.

**Auto-approve seam (`src/hitl/autonomy.ts`, new)**
`autoApproveAndExecute` mirrors `handleApprove` exactly: `resolveApproval`
(`resolved_by='_autonomous_'`) → `onApprovalResolved` (L2 memory) →
`onApprovalApproved` (execution enqueue). No Slack card is posted. Denylist:
`manual_operator_task` and `outreach_send_mailto` always stay HITL. Any
auto-approve failure leaves the row pending — degrades to the normal HITL path.

**Gate A — propose_action (`src/skills/seo/tools.ts` doProposeAction)**
After `createApproval`, full-autonomy tenants with an auto-executable toolName
skip the card and execute immediately.

**Gate B — Stage-2 publish (`src/integrations/framer/executor.ts`
execApproveBlogPitch)**
Autonomous path runs `qualityGateForAutonomousPublish` instead of the
best-effort `scoreAndMaybeRevise`:

1. Surfer AI detection (best-effort signal)
2. If flagged AI-ish → Surfer Humanizer → LLM fact re-verification against the
   pre-humanize draft (restores dropped stats/names/claims/links)
3. Content score; below threshold (75) → one revision pass → re-score
4. HARD verdict: score ≥ 75 → Stage 2 auto-approves, post publishes.
   Below threshold OR Surfer unavailable → **discard-and-retry**: the article
   is dropped before any Framer draft exists, a `publish-failed-{slug}` loss
   memory is written, and the next generation run drafts a fresh attempt with
   a different angle/topic. No Slack card, no human dependence — but never a
   blind publish. A Stage-2 card appears only as a RESCUE when the gate
   passed but the auto-approve itself errored (infra failure).

HITL tenants keep the existing behaviour byte-identical.

**Volume (`src/scheduler/types.ts`, `src/scheduler/worker.ts`,
`src/agents/subagent.ts`)**
New `daily_pm` run kind (maps to `cron-daily` trigger). Autonomous tenants get
a variant generation prompt: 1 article via `approve_blog_pitch` + 4-6
secondary actions per run, PM run must pick a different topic than AM.
Subagent daily_generation prompt raises the target to 5-7 propose_action
calls, adds no-churn rules (read before you change, no redo of last 7 days),
and explains the autonomous two-stage flow. Also fixed the stale
`framer_create_and_publish_blog_post` reference in the generic daily prompt —
it now says `approve_blog_pitch`, matching the system prompt.

Expected daily throughput for Tarino: 2 runs × (1 article + 4-6 actions)
= 10-14 actions, 2 articles.

## Deploy sequence

1. Push to main (auto-deploys to Cloud Run).
2. Run migrations:

```
npm run db:migrate
```

3. Run in Supabase SQL editor: `sql/20260712-tarino-autonomy.sql`
   (sets tarino to full, adds the 14:00 Sydney daily_pm schedule, includes
   verify queries and rollback).
4. Restart/redeploy so `bootstrapSchedules` registers the `daily_pm`
   repeatable (or wait for the next deploy). Verify Upstash key
   `bull:scheduled-runs:*tarino__daily_pm*` and Cloud Run log
   `schedule_registered`.

## Verify in production

- Cloud Run logs after the 08:00 run: `autonomous_auto_approved` entries,
  `surfer_autonomous_quality_gate` with `passed:true/false`.
- `approval_requests`: rows with `resolved_by='_autonomous_'` and
  `status='approved'`; `manual_operator_task` rows still `pending`.
- `tenant_memory`: `published-{slug}` rows appearing without a human click.
- Slack: execution-result receipts instead of approval cards; Stage-2 cards
  appear ONLY as a rescue when auto-approve errored after a passing gate.
- `tenant_memory`: `publish-failed-{slug}` loss rows for discarded articles —
  a day with one of these may ship 1 article instead of 2 (by design).

## Rollback

Data-only, no deploy: set `autonomy_level='hitl'` and disable the `daily_pm`
schedule (SQL at the bottom of `sql/20260712-tarino-autonomy.sql`). Takes
effect within the 5-minute tenant cache TTL.

## Verification run locally

- `npx tsc --noEmit` — clean except pre-existing `src/skills/ads/tools*.ts`
  errors (commit 7b4b779 imports `bid-changes`/`budget-changes`/`expansion`/
  `ad-copy` modules that the next Ads chunk hasn't delivered yet).
- `npx vitest run` — 140/140 tests pass (13 new: gate verdict, AI-verdict and
  humanized-text extraction, autonomy eligibility/denylist). The one failing
  test FILE is `src/skills/ads/tools.test.ts`, same pre-existing missing-module
  import, unrelated to this change.

## Known limits

- `manual_operator_task` items (marketing-page meta, robots.txt, sitemap,
  canonicals, new landing pages) still need you — genuine Framer API limits.
  They surface as normal cards and do not count toward the autonomous 10+.
- Surfer humanize/detect response shapes are extracted defensively
  (`extractAiVerdict`/`extractHumanizedText`); unparseable responses skip the
  humanize step and fall through to scoring, never to a blind publish.
- Weekly audit and end-of-week digest are unchanged.
