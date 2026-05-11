# R3 Finishing — Deployment Guide

Ships the missing pieces between R3 infrastructure (already in main) and R3 user-visible features. After this rollout, the Slack output looks the way the original R3 spec described: TL;DR, dot-point sections, severity-coded findings, first-person planning voice, **and clickable approval buttons that actually unblock the agent in ~2 seconds.**

**Branch:** `feat/r3-finishing`
**Bundle:** 15 file replacements + 1 SQL seed
**Migrations:** none (R3 migrations already ran in this morning's deploy)
**New dependencies:** none

---

## What's in this rollout

### Aggregator + voice + safety bounds (8 files)

| # | File | What changes |
|---|------|--------------|
| 1 | `src/types.ts` | Adds `TaskTrigger` type + optional `trigger` field on `AgentTask` |
| 2 | `src/queue/producer.ts` | `enqueueTask` accepts and forwards `trigger` |
| 3 | `src/tenants/slackManager.ts` | Stamps `trigger: 'slack-mention'` / `'slack-command'` on Slack-initiated tasks |
| 4 | `src/scheduler/worker.ts` | Stamps `trigger: 'cron-daily'` / `'cron-weekly'` on scheduled tasks |
| 5 | `src/orchestrator/aggregator.ts` | **Keystone change.** Three trigger-aware system prompts asking the LLM for structured JSON (`AdHocCheckReport` / `DailyRunReport` / `WeeklyAuditReport`). JSON-parse with graceful fallback to legacy string-passthrough on failure. |
| 6 | `src/orchestrator/index.ts` | Planner `plan_summary` reframed as first-person "what I'm planning to do" instead of transactional "spawned X specialists" |
| 7 | `src/agents/subagent.ts` | (a) Adds SEO tools for tenants with the `seo` skill. (b) Bounded retries on Anthropic API call (ECONNRESET / 5xx / 429 / timeouts; 1s→2s→4s backoff, max 3 attempts). (c) Per-call 90s timeout. (d) Hard 15-iteration cap. |
| 8 | `src/core/slack/blocks/shared.ts` | `normalizeSlackText` converts `[text](url)` → `<url\|text>` and `**bold**` → `*bold*`. `stripMarkdown` for `header` text. |

### HITL approval flow — dual-write architecture (4 files)

| # | File | What changes |
|---|------|--------------|
| 9 | `src/hitl/state-store.ts` | Adds `waitForApprovalResolution` — agent polls Postgres at 1.5s instead of Sheets at 15s. Adds `recordSheetRowNumber` to store the Sheet row coordinate on the PG row. |
| 10 | `src/hitl/sheets.ts` | `createApprovalRequest` accepts an external `id` so PG and Sheet share one approval ID. New `updateApprovalRowStatus` mirrors resolutions back to the Sheet when a button is clicked. |
| 11 | `src/hooks/index.ts` | Rewritten for dual-write: every approval gets a PG row (operational state, required) AND a Sheet row (persistent record, best-effort). Agent waits on PG. |
| 12 | `src/hitl/handlers.ts` | Slack button handlers update PG immediately, then mirror the decision back to the Sheet. All Sheet operations are best-effort — failures logged, never block the click flow. |
| 13 | `src/skills/seo/tools.ts` | `propose_action` (the SEO skill's approval entry point) now dual-writes to PG + Sheet, same as the generic hook path. Closes the audit-record gap for SEO-tool-initiated approvals (which are most of the approvals in a typical run). |

### Action surface expansion (2 files)

| # | File | What changes |
|---|------|--------------|
| 14 | `src/seo/types.ts` | `ActionType` enum expanded from 25 → 65 values. Adds explicit categories for indexing controls (`robots_txt_updated`, `noindex_added`, `canonical_updated`, redirects), site structure (`navigation_updated`, `url_slug_changed`), Google Business Profile actions (hours, photos, posts, attributes, Q&A, contact, reviews), restaurant-specifics for Tarino (menu items, pricing, hours, booking link, events, promotions), generic outreach beyond backlinks (`email_outreach_sent`, `haro_response_sent`, `partnership_outreach_sent`), Search Console actions (`gsc_disavow_uploaded` etc.), and the missing copy/CTA/OG/image actions. Analysis actions (competitor scraping, snapshots) remain un-gated. |
| 15 | `src/skills/seo/SKILL.md` | New "Action surface and approval gating" section enumerating every action type, what it changes, and its priority floor (P0 = irreversible / high blast radius like robots.txt; P1 = visible page changes; P2 = drafts and prep work). Includes the explicit workflow: identify → propose_action → wait for approval → execute → log_seo_action. Tells the agent exactly which actions require gating and which are read-only. |

### Schedule seed

| # | File | What it does |
|---|------|--------------|
| 13 | `sql/r3-finishing-seed.sql` | Two INSERTs: tarino daily @ 08:00 Sydney, weekly Monday @ 08:00 Sydney |

---

## The HITL architecture — two storage tiers

**Postgres `approval_requests`** = operational state.
The agent polls this. Slack button clicks land here first. Authoritative for "what's the current status of approval X right now?".

**Google Sheet** = persistent audit record.
Mirrored from PG at request and resolution time. Survives Slack message expiry and DB pruning. Queryable historically. Where you'd look to answer "what did we approve last week?".

**Slack messages** = ephemeral interaction surface.
Fast in-flow approve/reject; not the source of truth for anything.

**Failure modes are isolated by design:**
- PG write fails at request time → approval rejected immediately, agent gets a clear error (no silent hang)
- Sheets write fails at request time → warning logged, approval still works end-to-end via Slack + PG, just missing from the persistent audit record (re-add manually if needed)
- Sheets mirror fails at resolution time → warning logged, agent still unblocked, persistent record is one row behind (re-sync on next manual review)

**Polling latency:**
- Old (Sheets-poll): ~15s avg click-to-unblock
- New (PG-poll): ~1.5s avg click-to-unblock

---

## Pre-flight check

```bash
git fetch origin
git checkout main
git pull origin main
git status        # should be clean
git log -3 --oneline
```

## Step 1 — Create the branch, drop in the files

```bash
git checkout -b feat/r3-finishing
unzip -o ~/Downloads/r3-finishing.zip -d .
git status        # should show 15 modified files + 1 new SQL
```

## Step 2 — Local typecheck

```bash
npm install
npx tsc --noEmit
```

Expected: clean. Bundle was type-checked against your branch before shipping.

## Step 3 — Optional local smoke test

```bash
npm run dev
```

In a **dev** Slack channel:
```
@bot quick check on tarino.au homepage
```

Verify:
- "Tarino · Planning" header with first-person plan summary
- Markdown links render as clickable
- Final anchor has TL;DR / What's broken / What's working / Top leverage moves

## Step 4 — Commit and merge

```bash
git add src/ sql/

git commit -m "feat(r3-finishing): structured FinalReport + planner voice + SEO tools + safety bounds + HITL dual-write

Visible-output fixes:
- Aggregator: trigger-aware system prompts (ad_hoc/daily/weekly) emitting
  structured JSON FinalReport. Parsed by parseAggregatorOutput with
  graceful fallback to legacy string-passthrough on parse failure.
- Orchestrator: plan_summary framed in first-person 'what I'm planning to
  do' voice instead of transactional 'spawned X specialists'.
- Slack blocks: normalizeSlackText converts ChatGPT-style markdown to Slack
  mrkdwn at the section/context/fields boundary.

HITL approval flow — dual-write architecture:
- preToolUseHook now writes to BOTH Postgres approval_requests (operational
  state, required) AND Google Sheets (persistent audit record, best-effort)
  at request time. Same approval ID across both stores.
- Agent waits on PG via waitForApprovalResolution (1.5s poll cadence) —
  replaces the previous Sheets-poll path (15s cadence). Click-to-unblock
  drops from ~15s to ~2s.
- Slack button handlers update PG immediately, then mirror the decision
  back to the Sheet so the persistent audit record stays accurate.
- Sheet operations are best-effort throughout: failures are logged but
  never block the click flow or the agent.

Reliability:
- Subagent: SEO tool dispatch for tenants with the 'seo' skill. Bounded
  retries on Anthropic API call (ECONNRESET, 5xx, 429, timeouts; 1s/2s/4s
  backoff, max 3 attempts). Per-call 90s timeout. Hard 15-iteration cap
  to prevent runaway loops.

Plumbing:
- AgentTask: optional 'trigger' field threaded from Slack/cron through the
  whole pipeline so the aggregator can dispatch to the right system prompt.

Closes the gap between R3 infrastructure and R3 user-visible features."

git checkout main
git pull origin main
git merge feat/r3-finishing
git push origin main
```

Cloud Build fires. Watch at:
`https://console.cloud.google.com/cloud-build/builds?project=cgs-agent-shell-495221`

## Step 5 — Verify the new revision booted

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="tenant_bot_started"' \
  --limit=5 --format="value(timestamp,jsonPayload.tenantId)" \
  --order=desc --project=cgs-agent-shell-495221
```

Fresh `tarino` row should appear.

## Step 6 — Apply schedule seed + reload schedules

Supabase prod → SQL Editor → paste `sql/r3-finishing-seed.sql` → run.

Two tarino rows return at the bottom. Then:

```bash
gcloud run services update cgs-agent-shell \
  --region=us-central1 \
  --project=cgs-agent-shell-495221 \
  --update-env-vars="SCHEDULE_RELOAD_TS=$(date +%s)"
```

Confirm:
```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="scheduler_bootstrapped"' \
  --limit=3 --format="value(timestamp,jsonPayload.count)" \
  --order=desc --project=cgs-agent-shell-495221
```

`count: 2`.

## Step 7 — End-to-end verification

### 7a. Structured FinalReport rendering

In tarino Slack:
```
@tarino quick check on tarino.au homepage
```

Final anchor should show:
- Header + subtitle (domain · specialists · runtime)
- `*TL;DR*` with 3-5 bullets
- `*What's broken*` with severity glyphs
- `*What's working*`
- `*Top N leverage moves*` with P0/P1 priority codes
- Real clickable links

DB check:
```sql
SELECT task_id, state->>'phase' AS phase FROM slack_runs
 ORDER BY created_at DESC LIMIT 3;
```

Latest: `phase = 'complete'`. Aggregator log shows `kind: ad_hoc`.

### 7b. End-to-end HITL flow

Trigger something that requires approval. E.g.:
```
@tarino update the FAQ schema on tarino.au/menu and publish it
```

When the approval card appears:

1. **Verify Sheet row exists.** Open the tenant's HITL Sheet. New row with status='pending', ID matching the Slack button's approval ID.
2. **Verify PG row exists:**
   ```sql
   SELECT id, tool_name, status, sheet_row_number, requested_at
     FROM approval_requests ORDER BY requested_at DESC LIMIT 3;
   ```
   Latest: status='pending', sheet_row_number populated. ID should match the Sheet row.
3. **Click Approve.**
4. **Agent should unblock within ~2 seconds.** Watch the run anchor; specialist resumes.
5. **All three stores reflect the decision:**
   - PG: status='approved', resolved_by populated
   - Sheet: STATUS='approved', RESOLVED_AT + BY populated
   - Slack message: edited to "✅ Approved by @you"

Failure diagnostics:
- Sheet didn't update? `gcloud logging read ... jsonPayload.message="hitl_sheet_mirror_failed"` shows the cause.
- Agent didn't unblock? Check for `approval_resolved` log (PG happened) and `approval_granted` log (poll picked it up). The gap between these is your latency.

### 7c. Reject + Defer paths

Repeat 7b with **Reject**: PG status='rejected', Sheet STATUS='rejected', Slack message edited to "❌ Rejected", agent gets denied decision.

Repeat with **Defer 24h**: PG status stays 'pending' with defer_until set, Sheet STATUS='deferred', ephemeral message back to you.

## Step 8 — Wait for tomorrow's daily run

08:00 Sydney:
```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="schedule_run_enqueued"' \
  --limit=5 --format="value(timestamp,jsonPayload.tenantId,jsonPayload.runKind,jsonPayload.trigger)" \
  --order=desc --project=cgs-agent-shell-495221
```

`tenantId: tarino, runKind: daily, trigger: cron-daily`. First daily run may have sparse content (`seo_work_log` empty until specialists log work) — expected.

---

## Rollback

```bash
# Find a previous revision
gcloud run revisions list --service=cgs-agent-shell --region=us-central1 \
  --project=cgs-agent-shell-495221 --limit=5

# Roll traffic back to it
gcloud run services update-traffic cgs-agent-shell \
  --region=us-central1 --project=cgs-agent-shell-495221 \
  --to-revisions=<revision-name>=100
```

Schedule rollback:
```sql
UPDATE tenant_schedules SET enabled = false WHERE tenant_id = 'tarino';
```

The HITL changes are forward-compatible: rolling back to the prior revision will still work because PG rows from new approvals just won't be picked up by the old Sheets-poll path. Worst case: in-flight approvals from the new code don't get unblocked by an old-code revision; they time out at 30 min. To avoid that, drain the queue before rolling back.

---

## What's NOT in this rollout — and why

- **Prompt caching** (AGENT-TODO #1) — high value but needs careful refactor. Separate rollout.
- **Sheet → PG sync.** Manual Sheet edits don't flow back to PG yet. If you mark an approval `approved` directly in the Sheet, the agent won't see it. Use Slack buttons for resolution; treat the Sheet as audit-only for now. A future feature could poll the Sheet for status changes and back-sync.
- **`job_done` not stopping the executor.** Iteration cap caps the blast radius; signal-propagation issue is its own investigation.
- **Investigate streaming connection resets.** Now that errors are properly retried with code/syscall context, the next runaway will be diagnosable.

All stay on AGENT-TODO.md.
