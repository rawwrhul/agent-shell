# R3 Finishing — Noob Deployment Guide

This is the walk-me-through-every-step version. If you've never deployed this app before, follow this from top to bottom. Every command is copy-pasteable. Every expected output is described. Every "what if X breaks" branch is covered.

If you already know what you're doing, the shorter `DEPLOY-R3-FINISHING.md` in this same folder has the same content without the hand-holding.

**Total time:** 30–45 minutes if everything goes smoothly. Add 15–30 min buffer for first-deploy hiccups.

---

## What you'll have at the end

A new revision of your Cloud Run service running with:

1. **Structured Slack output** — Slack runs end with a TL;DR + dot-point sections (What's broken / What's working / Top leverage moves), not a wall of markdown text
2. **Working approval flow** — when the agent proposes a change, you click Approve in Slack and the agent unblocks within ~2 seconds. The Sheet keeps a permanent record of every approval.
3. **Daily + weekly cron** firing at 08:00 Sydney time
4. **Bounded retries** — no more runaway loops eating tokens
5. **The full action surface** — agent knows what it can propose and what requires approval

---

## Before you start — what you need open

You'll need these in front of you. Open them now:

### 1. A terminal
- macOS: open **Terminal.app** (or **iTerm**, or whatever you use)
- You'll be running git, npm, gcloud, and unzip commands here

### 2. Your repo on disk
- The local clone of `agent-shell-main`
- If you don't remember where it is: `find ~ -name "agent-shell-main" -type d 2>/dev/null | head -5`
- Once you find it, `cd` into it: e.g. `cd ~/code/agent-shell-main`

### 3. The bundle
- The file `r3-finishing.zip` you downloaded from this chat
- By default it's in `~/Downloads/r3-finishing.zip`
- If you put it somewhere else, note that path — you'll need it in Step 2

### 4. Three browser tabs
- **Cloud Build console:** https://console.cloud.google.com/cloud-build/builds?project=cgs-agent-shell-495221
- **Cloud Run console:** https://console.cloud.google.com/run?project=cgs-agent-shell-495221
- **Supabase prod:** the SQL editor for your production database

### 5. Slack
- The tarino workspace, with the channel where the agent posts

### 6. The HITL Sheet
- Open the tenant's approval Sheet (the one mapped to `tenants.hitlSpreadsheetId` for tarino). If you don't know which Sheet that is, you can find the ID by running this in Supabase:
  ```sql
  SELECT tenant_id, hitl_spreadsheet_id FROM tenants WHERE tenant_id = 'tarino';
  ```
  Then open `https://docs.google.com/spreadsheets/d/<that-id>/edit` in a browser tab.

---

## Step 0 — Verify your starting point

**Why:** before we change anything, we want to confirm the repo is in a known-good state. If your local repo has uncommitted changes or is behind origin, we fix that now.

In your terminal, in the repo directory:

```bash
git fetch origin
git checkout main
git pull origin main
git status
git log -3 --oneline
```

**What `git status` should say:**
```
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

If it says anything *other* than "working tree clean", **STOP**. Either:
- You have uncommitted changes — figure out what they are. If they're work you want to keep, commit them on a branch first. If not, `git stash` them.
- You're on a different branch — `git checkout main` and try again.

**What `git log -3 --oneline` should show:**
```
<short hash>  feat: SlackPresenter (rollout 1) — anchor + threading + HITL post
<short hash>  (the commit before R1)
<short hash>  (the one before that)
```

The top commit should be this morning's R1 ship. If it's not, paste the output to me and we'll figure out where you are.

**Paste me the output of these two commands** (`git status` and `git log -3 --oneline`) before you proceed. I want to confirm you're starting from clean main with R1 as the latest commit.

---

## Step 1 — Create the deploy branch

**Why:** all our changes go on a feature branch so we can review the diff, run tests, and back out if anything looks wrong — without ever touching main.

```bash
git checkout -b feat/r3-finishing
```

**Expected output:**
```
Switched to a new branch 'feat/r3-finishing'
```

If it errors with "a branch named feat/r3-finishing already exists", you have an older branch from an earlier attempt. Delete it and try again:
```bash
git branch -D feat/r3-finishing
git checkout -b feat/r3-finishing
```

---

## Step 2 — Drop the bundle into your repo

**Why:** the zip contains the 15 updated source files. Unzipping it directly into your repo root replaces the existing files with the new versions.

Replace `~/Downloads/r3-finishing.zip` with wherever you actually saved the zip:

```bash
unzip -o ~/Downloads/r3-finishing.zip -d /tmp/r3-extract
cp -r /tmp/r3-extract/r3-finishing/src/* src/
cp -r /tmp/r3-extract/r3-finishing/sql sql 2>/dev/null || mkdir sql && cp /tmp/r3-extract/r3-finishing/sql/* sql/
cp /tmp/r3-extract/r3-finishing/DEPLOY-R3-FINISHING.md ./
cp /tmp/r3-extract/r3-finishing/DEPLOY-NOOB.md ./
```

The `-o` flag means "overwrite without asking". The intermediate `/tmp/r3-extract` step keeps the unzip clean before we copy files into the repo.

**Verify it worked:**

```bash
git status
```

**What you should see:**
```
On branch feat/r3-finishing
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   src/agents/subagent.ts
	modified:   src/core/slack/blocks/shared.ts
	modified:   src/hitl/handlers.ts
	modified:   src/hitl/sheets.ts
	modified:   src/hitl/state-store.ts
	modified:   src/hooks/index.ts
	modified:   src/orchestrator/aggregator.ts
	modified:   src/orchestrator/index.ts
	modified:   src/queue/producer.ts
	modified:   src/scheduler/worker.ts
	modified:   src/seo/types.ts
	modified:   src/skills/seo/SKILL.md
	modified:   src/skills/seo/tools.ts
	modified:   src/tenants/slackManager.ts
	modified:   src/types.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	DEPLOY-NOOB.md
	DEPLOY-R3-FINISHING.md
	sql/
```

**The exact count to verify:** 15 files in `Changes not staged` + 2 untracked `.md` files + 1 untracked `sql/` directory.

If you see anything different (especially fewer than 15 modified files, or files in unexpected places), **STOP** and paste me the output. We'll figure out what went wrong before continuing.

**Paste me this `git status` output** before moving on.

---

## Step 3 — Type-check

**Why:** if any of the new files have TypeScript errors against your repo's current state, we want to know *now* — not after pushing to main and triggering Cloud Build.

```bash
npm install
npx tsc --noEmit
```

`npm install` should complete in 30–60 seconds. It might print some warnings about deprecated packages — that's normal, ignore them.

`npx tsc --noEmit` does a full type-check without producing any output files. If everything's good, **it prints nothing and returns silently** in 20–40 seconds.

**If you see errors**, they'll look like:
```
src/somefile.ts(42,5): error TS1234: Some error message
```

If you get errors, **paste the full output to me** and we'll fix before going further. Don't try to fix them yourself — the type errors might indicate an upstream mismatch that needs the right fix.

**If it's silent (no output) — perfect.** Move on.

---

## Step 4 — (Optional but recommended) local smoke test

**Why:** this is the cheapest way to catch a problem before pushing to prod. We run the app locally and trigger one test message.

**Skip this step if** your local dev environment isn't set up. Going straight to prod is fine — there are safety nets (kill switch + revision rollback).

If you have a local dev setup:

```bash
npm run dev
```

The app should start up. You'll see logs like:
```
{ level: 'info', msg: 'starting_tenant_bots', count: N }
{ level: 'info', msg: 'tenant_bot_started', tenantId: 'tarino' }
{ level: 'info', msg: 'scheduler_bootstrapped', count: 0 }  // or N if you've already seeded
{ level: 'info', msg: 'schedule_worker_started' }
```

**Important:** while local dev is running, your local instance is competing with prod for Slack events. Either disable the prod Cloud Run service temporarily, or do your test in a *different* Slack channel that prod doesn't watch.

In Slack, in a test channel, send: `@bot quick check on tarino.au homepage` (use whatever the bot's actual name is in your dev workspace).

Watch for:
- Anchor message appears with "Tarino · Planning" header
- Plan text shows in first-person voice ("Going to check..." not "Spawned a specialist...")
- Final report has TL;DR + dot-point sections
- Markdown links render as actual clickable links

When you're done, hit `Ctrl+C` in the terminal to stop the local server.

If local smoke worked, you're confident the bundle is good. Move on to Step 5.

---

## Step 5 — Commit

**Why:** snapshot your work-in-progress as a git commit before merging.

```bash
git add src/ sql/ DEPLOY-R3-FINISHING.md DEPLOY-NOOB.md
```

This stages all the modified files plus the new sql/ directory and the two deploy docs.

```bash
git status
```

You should now see everything under "Changes to be committed" instead of "not staged":

```
Changes to be committed:
	new file:   DEPLOY-NOOB.md
	new file:   DEPLOY-R3-FINISHING.md
	modified:   src/agents/subagent.ts
	... (15 modified, 1 new sql file)
	new file:   sql/r3-finishing-seed.sql
```

Then commit:

```bash
git commit -m "feat(r3-finishing): structured FinalReport + planner voice + SEO tools + HITL dual-write + action surface

Closes the gap between R3 infrastructure (shipped this morning) and R3
user-visible features.

Visible-output fixes:
- Aggregator: trigger-aware system prompts (ad_hoc/daily/weekly) emitting
  structured JSON FinalReport. Parsed with graceful fallback to legacy
  string-passthrough on JSON parse failure.
- Orchestrator: plan_summary framed in first-person 'what I'm planning to
  do' voice instead of transactional 'spawned X specialists'.
- Slack blocks: normalizeSlackText converts ChatGPT-style markdown to
  Slack mrkdwn ([text](url) → <url|text>, **bold** → *bold*).

HITL approval flow — dual-write architecture:
- preToolUseHook + seo/tools.ts:propose_action now write to both
  Postgres approval_requests (operational state) AND Google Sheet
  (persistent audit record), same approval ID across both.
- Agent waits on PG via waitForApprovalResolution (1.5s poll cadence)
  instead of Sheets (15s) — click-to-unblock drops from ~15s to ~2s.
- Slack button handlers update PG immediately, then mirror back to Sheet.
- Sheet operations are best-effort: failures logged, never block the
  click flow or the agent.

Action surface expansion:
- ActionType enum expanded from 25 → 65 values. Adds indexing controls
  (robots.txt, noindex, canonical, redirects), site structure (nav, URL
  slugs), Google Business Profile actions (hours, photos, posts, reviews,
  Q&A), restaurant-specifics (menu items, pricing, hours, booking,
  events, promotions), generic outreach, GSC actions, and missing copy/
  CTA/OG/image actions.
- SKILL.md adds 'Action surface and approval gating' section with
  per-action priority guidance.

Reliability:
- Subagent: bounded retries on Anthropic API call (ECONNRESET, 5xx, 429,
  timeouts; 1s/2s/4s backoff, max 3 attempts). Per-call 90s timeout.
  Hard 15-iteration cap to prevent runaway loops.

Plumbing:
- AgentTask: optional 'trigger' field threaded from Slack/cron through
  the whole pipeline so the aggregator dispatches to the right prompt."
```

Press Enter. You should see something like:

```
[feat/r3-finishing abc1234] feat(r3-finishing): structured FinalReport + ...
 17 files changed, 1245 insertions(+), 320 deletions(-)
 create mode 100644 DEPLOY-NOOB.md
 create mode 100644 DEPLOY-R3-FINISHING.md
 create mode 100644 sql/r3-finishing-seed.sql
```

The exact insertion/deletion counts will vary. The important thing is that it commits successfully.

---

## Step 6 — Merge to main and push

**Why:** this triggers Cloud Build, which runs the deploy.

```bash
git checkout main
git pull origin main
git merge feat/r3-finishing
```

**Expected output of `git merge`:**
```
Updating <hash>..<hash>
Fast-forward
 ... (file list)
 17 files changed, ...
```

If git asks you to write a merge message (you'll see an editor pop up), the default message is fine — save and exit (in vim: `:wq`, in nano: Ctrl+X then Y).

Then push:

```bash
git push origin main
```

**Expected output:**
```
Enumerating objects: ...
...
To github.com:<your-org>/agent-shell-main.git
   <hash>..<hash>  main -> main
```

**The push triggers Cloud Build automatically.**

---

## Step 7 — Watch Cloud Build

Open the Cloud Build tab you opened at the start:
`https://console.cloud.google.com/cloud-build/builds?project=cgs-agent-shell-495221`

You should see a new build at the top of the list with status **Working** (yellow circle). Click on it.

The build runs through these phases (each phase shows a green checkmark when done):
1. **FETCHSOURCE** — pulling your latest commit (~10 sec)
2. **BUILD** — running `npm install`, then compiling the TypeScript (~2–3 min)
3. **PUSH** — pushing the new Docker image to Container Registry (~30 sec)
4. **DEPLOY** — Cloud Run creates a new revision and routes traffic to it (~1 min)

**Total time: 3–5 minutes.**

**If it goes green** (status changes to **Success** with a green checkmark): proceed to Step 8.

**If it fails** (status **Failed**, red icon): click on the failed phase to see the logs. The most common failures are:
- TS compilation error → we missed something in Step 3's type-check. Fix on a new branch and re-push.
- npm install timeout → just retry (click "REBUILD" at the top of the build page)
- Docker push failure → Google's side, retry

Paste the error to me if you can't immediately tell what's wrong.

---

## Step 8 — Verify the new revision booted

**Why:** Cloud Build succeeding means the build deployed. We now want to confirm the *running* container is healthy and tenant bots have reconnected.

Open your terminal. Run this:

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="tenant_bot_started"' \
  --limit=5 --format="value(timestamp,jsonPayload.tenantId)" \
  --order=desc --project=cgs-agent-shell-495221
```

**What you should see** — a list of recent `tenant_bot_started` log entries with timestamps:

```
2026-05-11T05:XX:XX.XXXXXXZ    tarino
2026-05-11T05:XX:XX.XXXXXXZ    tarino
... (older entries)
```

The top entry should have a **fresh timestamp from the last few minutes** — that's the new revision booting up and starting the tarino bot. If you don't see a fresh entry, wait another 30 seconds and re-run. Cloud Run can take a moment to spin up the new revision.

If the top entry is still from earlier (say, this morning's deploy), something didn't actually deploy. Open the Cloud Run console tab and look at the revisions list — you should see a `cgs-agent-shell-000XX-xxx` revision with the most recent "Deployed at" timestamp. If you don't, the deploy didn't take effect.

---

## Step 9 — Apply the schedule seed

**Why:** The cron infrastructure was already running, but no tenants had rows in `tenant_schedules` yet. Without rows, no cron jobs get scheduled. We're now adding rows for tarino.

Open your Supabase prod tab → **SQL Editor** → **New query**.

Paste the contents of `sql/r3-finishing-seed.sql` (it's also reproduced here for convenience):

```sql
INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES
  ('tarino', 'daily',  '0 8 * * *', 'Australia/Sydney', true),
  ('tarino', 'weekly', '0 8 * * 1', 'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind) DO NOTHING;

SELECT tenant_id, run_kind, cron_expr, timezone, enabled, created_at
  FROM tenant_schedules
 WHERE tenant_id = 'tarino'
 ORDER BY run_kind;
```

Click **Run** (or hit Cmd+Enter).

**What you should see:** the bottom SELECT returns 2 rows:

```
tenant_id  | run_kind | cron_expr | timezone         | enabled | created_at
-----------+----------+-----------+------------------+---------+------------
tarino     | daily    | 0 8 * * * | Australia/Sydney | true    | 2026-05-11 ...
tarino     | weekly   | 0 8 * * 1 | Australia/Sydney | true    | 2026-05-11 ...
```

If you get **"relation tenant_schedules does not exist"** — the R3 migrations didn't run when this morning's deploy went up. That'd be unusual but recoverable; paste the error to me.

If you get **2 rows back**, the seed worked. Move on.

---

## Step 10 — Reload schedules

**Why:** `bootstrapSchedules()` runs at app startup. It reads `tenant_schedules` and registers cron jobs with BullMQ. We need to trigger a fresh startup so it picks up the rows you just inserted.

In your terminal:

```bash
gcloud run services update cgs-agent-shell \
  --region=us-central1 \
  --project=cgs-agent-shell-495221 \
  --update-env-vars="SCHEDULE_RELOAD_TS=$(date +%s)"
```

This sets a dummy environment variable (timestamped to be unique each time), which Cloud Run interprets as a config change and creates a new revision. The old revision drains; the new one boots and runs `bootstrapSchedules()` against the now-populated table.

**Expected output:**
```
Deploying...
✓ Creating Revision...
✓ Routing traffic...
Done.
Service [cgs-agent-shell] revision [cgs-agent-shell-000XX-xxx] has been deployed
and is serving 100 percent of traffic.
```

This takes 1–2 minutes.

**Verify the bootstrap picked up the new rows:**

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="scheduler_bootstrapped"' \
  --limit=3 --format="value(timestamp,jsonPayload.count)" \
  --order=desc --project=cgs-agent-shell-495221
```

**What you should see** — top entry should have `count: 2`:

```
2026-05-11T05:XX:XX.XXXXXXZ    2
2026-05-11T05:XX:XX.XXXXXXZ    0
2026-05-11T04:XX:XX.XXXXXXZ    0
```

The top `2` is your new revision picking up both tarino schedules. The earlier `0` values are previous revisions (before you seeded). If the top entry says `count: 0`, the schedules weren't read — re-check the seed SQL ran correctly in Step 9.

If you see `count: 2`, your cron is officially live.

---

## Step 11 — End-to-end test #1: structured Slack output

**Why:** the keystone of this rollout is the new structured output. Let's verify it works in prod.

In the tarino Slack channel, send:

```
@tarino quick check on tarino.au homepage
```

**Watch the anchor message that appears.** It should show, in order:

1. Within a few seconds: header showing **🔍 Tarino · Planning** (or similar)
2. Plan text showing in first-person voice — e.g. **"Going to check the homepage HTTP response, schema markup, and key meta tags."** NOT "Spawned a specialist to perform a comprehensive technical SEO check..."
3. Phase changes to **Running** as the specialist works
4. Spinner icon **◐ Task Executor** updating live
5. Eventually phase changes to **Complete** with a final structured report

**The final report should have these sections:**
- **TL;DR** — 3-5 bullet points summarising the run
- **What's broken** — items with severity glyphs (🔴/🟠/🟡)
- **What's working** — green-glyph items
- **Top N leverage moves** — items with `P0`/`P1` priority codes

**Markdown links should appear as actual clickable links** — e.g. "tarino.au" should be underlined and clickable, not displayed as raw `[tarino.au](http://tarino.au)`.

**If the structure looks right** — that's the keystone test passing. Move on to the next test.

**If the run hangs for more than 5 minutes** — the runaway-prevention from this morning is supposed to cap this. Check:
```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="subagent_iteration_cap_hit"' \
  --limit=3 --format="value(timestamp,jsonPayload.taskId,jsonPayload.cap)" \
  --order=desc --project=cgs-agent-shell-495221
```

If you see entries, the cap kicked in at 15 iterations and stopped the loop. The agent should produce a partial output and the run should complete (just with a less-thorough result). If the run is *truly* hung even past the cap, paste me the most recent logs and we'll diagnose.

**If the report shows up but looks like plain text** (no TL;DR section, no bullet structure):
```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="aggregator_structured_parse_failed_falling_back"' \
  --limit=3 --format="value(timestamp,jsonPayload.taskId,jsonPayload.reason)" \
  --order=desc --project=cgs-agent-shell-495221
```

If you see entries, the model emitted non-JSON output and the aggregator fell back to legacy rendering. The `reason` field tells you why (e.g. `no_json_object_in_output`, `kind_mismatch`). This is a model behavior issue, not a code issue — usually fixed by tweaking the aggregator system prompt to be more emphatic about JSON-only output. Tell me the reason and we'll iterate.

---

## Step 12 — End-to-end test #2: HITL approval flow

**Why:** the dual-write architecture is new and unverified end-to-end. Let's prove a button click in Slack updates PG, mirrors to the Sheet, and unblocks the agent.

In tarino Slack:

```
@tarino propose adding FAQ schema to tarino.au/menu and explain why it would help
```

The agent should run for ~1-2 minutes, then post an approval card to Slack with buttons: **View draft**, **Approve**, **Reject**, **Defer 24h**, **Open in Sheets**.

**Before clicking anything**, verify the dual-write happened:

**(a) Check the Sheet** — switch to your Google Sheets tab. There should be a new row at the bottom with:
- Column A: a UUID (the approval ID)
- Column D: a tool name (probably `add_schema` or similar)
- Column I: `pending`
- Other columns populated

**(b) Check Postgres** — in Supabase SQL Editor:
```sql
SELECT id, tool_name, status, slack_channel_id, sheet_row_number,
       priority, proposed_action, requested_at
  FROM approval_requests
 ORDER BY requested_at DESC LIMIT 3;
```

Top row should have:
- `status` = `pending`
- `tool_name` populated
- `slack_channel_id` populated (your channel ID)
- `sheet_row_number` populated (the row in the Sheet)
- `proposed_action` populated
- `priority` set (probably `P1`)

**Critical check: the `id` in PG should match the UUID in column A of the Sheet.** Same approval, two stores.

**Now click Approve in Slack.**

**Watch what happens:**

1. **The Slack approval message edits in place** to show "✅ Approved by @you" with a timestamp. This should happen within ~500ms of clicking.

2. **The agent's run anchor should resume.** Within ~2 seconds, the specialist that was blocked should unblock and continue (you'll see its progress update).

3. **The Sheet row should update** — column I (Status) changes from `pending` to `approved`, column J (Resolved At) gets a timestamp, column K (Resolved By) gets your Slack user ID.

4. **The PG row should update:**
   ```sql
   SELECT id, status, resolved_at, resolved_by FROM approval_requests
    ORDER BY requested_at DESC LIMIT 3;
   ```
   Top row: `status='approved'`, `resolved_at` populated, `resolved_by` is your Slack user ID.

If all four happen — **the HITL flow is officially working.** This is the big win of this rollout.

**If the agent didn't unblock within 5 seconds of clicking Approve:**
```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND (jsonPayload.message="approval_resolved" OR jsonPayload.message="approval_granted")' \
  --limit=10 --format="value(timestamp,jsonPayload.message,jsonPayload.approvalId)" \
  --order=desc --project=cgs-agent-shell-495221
```

You should see two log entries for your approval ID, milliseconds apart:
- `approval_resolved` (PG update from the button click)
- `approval_granted` (the agent's poll loop picked it up)

If you only see `approval_resolved` and never `approval_granted`, the agent isn't polling correctly. Paste me the output and we'll diagnose.

**If the Sheet didn't update** (PG updated correctly but Sheet still shows pending):
```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="hitl_sheet_mirror_failed"' \
  --limit=5 --format="value(timestamp,jsonPayload.approvalId,jsonPayload.err)" \
  --order=desc --project=cgs-agent-shell-495221
```

This will tell you why the Sheet mirror failed. Most common causes:
- Google Service Account doesn't have edit access to the Sheet — fix by sharing the Sheet with the SA email
- Sheet ID misconfigured in tenant config
- Rate limit on Google Sheets API

The PG row is authoritative either way, so the agent is still unblocked. The Sheet mirror failing is a "fix this when you have time" issue, not a blocker.

---

## Step 13 — Verify Reject and Defer too

**Why:** Approve is the happy path. Reject and Defer have different update semantics — worth a quick test.

In tarino Slack, trigger another approval:
```
@tarino propose a small copy change to the about page
```

When the card appears, **click Reject**.

Verify:
- PG: `status='rejected'`, `rejection_reason` populated if you provided one
- Sheet: column I = `rejected`
- Slack message: "❌ Rejected"
- Agent: receives the rejection and the specialist's tool call returns a "denied" decision (it should log this and continue gracefully — not crash)

Then trigger another approval and click **Defer 24h**.

Verify:
- PG: `status` stays `pending` (defer isn't terminal), but `defer_until` is set to ~24h from now
- Sheet: column I = `deferred`
- Slack: ephemeral message back to you saying "Deferred. Will reappear in tomorrow's daily run if not actioned."
- Agent: stays blocked, will time out at 30 min if no explicit answer comes

---

## Step 14 — Wait for tomorrow's daily cron

**Why:** the cron is now seeded. At 08:00 Sydney time tomorrow, the daily run should fire automatically.

Set a reminder to check at 08:05 Sydney tomorrow:

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="cgs-agent-shell" AND jsonPayload.message="schedule_run_enqueued"' \
  --limit=5 --format="value(timestamp,jsonPayload.tenantId,jsonPayload.runKind,jsonPayload.trigger)" \
  --order=desc --project=cgs-agent-shell-495221
```

Expected:
```
2026-05-12T22:00:00.XXXXXXZ    tarino  daily  cron-daily
```

(Note: 22:00 UTC = 08:00 Sydney.)

The daily run will appear in Slack like a regular task, but with a `DailyRunReport` structured output (sections: Shipped overnight / New opportunities / Queued for today / Awaiting your call) instead of an `AdHocCheckReport`.

The first daily run will likely be sparse because `seo_work_log` is empty — that's expected. Each day fills in more as specialists log work.

---

## You're done

Deploy complete. Take 10 min, eat something, then come back and look at what shipped:
- Slack has a structured anchor format for every run
- Approval flow is sub-2-second from click to unblock
- Sheet is the full persistent audit record
- Cron is wired for daily + weekly
- Action surface covers 65 distinct action types the agent can propose

**What's next** is the execution layer — wiring up MCPs and tools so approved actions can actually be executed by the agent rather than just proposed. That's a separate conversation when you're ready.

---

## If something goes really wrong: rollback

If at any point you decide the deploy is broken and you want to revert to this morning's R1 state:

**1. Find the previous revision name:**
```bash
gcloud run revisions list --service=cgs-agent-shell --region=us-central1 --project=cgs-agent-shell-495221 --limit=10
```

Look for a revision named like `cgs-agent-shell-00010-6dc` (this morning's R1 deploy). Note its full name.

**2. Route 100% of traffic to that revision:**
```bash
gcloud run services update-traffic cgs-agent-shell \
  --region=us-central1 \
  --project=cgs-agent-shell-495221 \
  --to-revisions=cgs-agent-shell-00010-6dc=100
```

Replace `cgs-agent-shell-00010-6dc` with the actual revision name from step 1.

**3. Disable the cron schedules** (to stop the cron firing from running cleaner old code against newer DB state):
```sql
UPDATE tenant_schedules SET enabled = false WHERE tenant_id = 'tarino';
```

**4. Tell me what happened** — paste the error or describe what's wrong. We'll diagnose and produce a fix.

Rollback is essentially instant. Cloud Run revisions are immutable — the old one is sitting there ready to take traffic back. The only thing not auto-rolled-back is data: any approvals from the new code that were resolved during the new revision's run will keep their resolved state, which is fine.

---

## Reference: what each terminal command does

For future reference, if you see one of these and want to understand what it's doing:

| Command | What it does |
|---|---|
| `git fetch origin` | Pulls down latest refs from GitHub without changing your working tree |
| `git checkout main` | Switches your working tree to the main branch |
| `git pull origin main` | Fast-forwards your local main to match origin |
| `git checkout -b feat/X` | Creates a new branch off your current state, switches to it |
| `git status` | Shows what's modified, staged, untracked |
| `git add .` | Stages every modified/new file in current dir + subdirs |
| `git commit -m "..."` | Snapshots staged files into a commit |
| `git merge feat/X` | Brings the commits from branch X into the current branch |
| `git push origin main` | Sends your local main commits to GitHub (triggers Cloud Build) |
| `npm install` | Installs dependencies listed in package.json |
| `npx tsc --noEmit` | Type-checks TS code without writing output files |
| `npm run dev` | Runs whatever's in package.json's `scripts.dev` (usually starts the app locally) |
| `unzip -o X.zip -d Y` | Extracts X.zip into directory Y, overwriting existing files |
| `gcloud logging read 'QUERY'` | Reads logs matching QUERY from Google Cloud Logging |
| `gcloud run services update X` | Updates a Cloud Run service config (often triggers a new revision) |
| `gcloud run revisions list` | Lists past revisions of a service |
| `gcloud run services update-traffic` | Routes traffic between revisions |

---

If you get stuck on any step, copy the exact terminal output (or screenshot of the Slack/Sheet/Supabase view) and paste it. We'll diagnose and unblock.
