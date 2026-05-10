# Deploying SlackPresenter (Rollout 1)

Step-by-step guide for landing the Slack presenter layer. After this is
live:

- One **anchor message** per agent run, edited in place as state changes.
  Specialists progress visibly: queued → running → complete/failed,
  rather than the channel going silent for 6–15 minutes.
- Per-specialist detail and the final report go in the anchor's **thread**
  so the channel stays uncluttered.
- HITL approval requests post a **separate, non-threaded** message to the
  channel — closes the gap where the agent silently waited 30 minutes for
  approval with no visible signal.
- Run state lives in `slack_runs`, mutated under `SELECT … FOR UPDATE`,
  so concurrent specialist completions across BullMQ workers can't
  trample each other.

This is shell-general — every agent type (seo-auditor, content-writer,
data-analyst, etc) gets the new presentation layer for free.

---

## Scope

This rollout includes:

- One new table: `slack_runs` (per-task durable state for the anchor).
- Five new TypeScript modules in `src/core/slack/`.
- Modifications to `slackManager`, `worker`, `orchestrator/index`,
  `orchestrator/aggregator`, `agents/subagent`, `hooks/index`.
- Two non-runtime additions: `agents/runner` and `agents/initializer`
  pick up the new `channelId` field on `HookContext`.
- A pure-function smoke script: `scripts/smoke-slack-render.ts`.

It does **not** include:

- Block Kit (rich layout). The presenter renders mrkdwn for now. Block
  Kit would unlock cancel buttons, inline rollback prompts, and
  per-specialist expand/collapse — left for a follow-up.
- Per-tenant rate-limit handling. Slack `chat.update` errors are logged
  and swallowed; if your tenants edit the same anchor faster than Slack
  allows, some edits get dropped. State stays consistent in the DB.
- Removal of `postToSlack`. It's tagged `@deprecated`; no callers remain
  in the changed files. Deletable in a follow-up once you're confident
  nothing in tests, evals, or skill code reaches for it.

---

## Prerequisites

- Existing v3 shell deployed and working.
- Local development environment runs cleanly (`npm run dev`).
- Familiarity with the `feat/<branch>` → `main` workflow.
  (No `dev` branch is needed — your repo currently has only `main`.)
- At least one test tenant configured for end-to-end verification.

---

## File inventory

**5 new files**

| Path                                 | Purpose                                                           |
|--------------------------------------|-------------------------------------------------------------------|
| `src/core/slack/types.ts`            | RunState, SpecialistState, RunPhase, error class                  |
| `src/core/slack/render.ts`           | Pure functions: state → mrkdwn (zero I/O, trivially testable)     |
| `src/core/slack/state-store.ts`      | DB ops, including `mutateRunState` with SELECT FOR UPDATE         |
| `src/core/slack/presenter.ts`        | The `SlackPresenter` class — public API                           |
| `src/core/slack/index.ts`            | Module-level singleton + barrel exports                           |
| `scripts/smoke-slack-render.ts`      | (Optional) eyeball test for the rendering layer                   |

**9 modified files**

| Path                              | What changed                                                                                  |
|-----------------------------------|-----------------------------------------------------------------------------------------------|
| `db/migrate.ts`                   | Adds `slack_runs` table + `idx_slack_runs_tenant_updated`                                     |
| `src/tenants/slackManager.ts`     | `apps` Map now exported; `postToSlack` kept as deprecated escape hatch                         |
| `src/queue/worker.ts`             | Calls `presenter.startRun` / `postBudgetWarning` / `failRun` instead of raw `postToSlack`     |
| `src/orchestrator/index.ts`       | Per-spawn `recordSpecialistQueued` and `recordPlanComplete` replace channel posts             |
| `src/orchestrator/aggregator.ts`  | `setPhase('synthesising')` and `completeRun(report)` replace 4 raw posts                      |
| `src/agents/subagent.ts`          | New: `recordSpecialistStart/Complete/Failure` calls — fixes the long-silence problem          |
| `src/hooks/index.ts`              | New: `requestApproval` and `approvalResolved` calls — closes the HITL Slack gap                |
| `src/agents/runner.ts`            | `channelId` added to `HookContext` construction                                                |
| `src/agents/initializer.ts`       | `channelId` added to `HookContext` construction                                                |

**No new dependencies.** No environment variable changes. No
`cloudrun.yaml` changes.

---

## Step-by-step

### 1. Create a feature branch

```bash
cd ~/Projects/CGSAgent/agent-shell-v3
git checkout main
git pull origin main
git checkout -b feat/slack-presenter
```

### 2. Drop in the new + modified files

Extract `slack-presenter-changes.zip` (provided alongside this guide) on
top of your repo. The zip is structured to mirror repo paths exactly, so
the safe move is:

```bash
unzip -o slack-presenter-changes.zip -d .
```

`-o` overwrites without prompting (safe — every file in the zip is one
of the 14 listed above; extracting will not touch anything else). After
extraction, run `git status` to confirm the file list matches the
inventory above.

### 3. Typecheck

```bash
npm install      # no new deps, but harmless
npm run typecheck
```

Should be clean. If you see errors mentioning `HookContext` missing
`channelId`, you have a custom call site of `preToolUseHook` not in the
inventory — add `channelId: task.slackChannelId` to that call site's
`hookCtx` object.

### 4. Apply the migration on dev

```bash
npm run db:migrate
```

Look for `Creating table: slack_runs` (or no error if it already exists
— `CREATE TABLE IF NOT EXISTS` is idempotent). Verify:

```bash
psql "$DATABASE_URL" -c "\d slack_runs"
```

You should see five columns plus the `idx_slack_runs_tenant_updated`
index on `(tenant_id, updated_at DESC)`.

### 5. Eyeball the render output

```bash
npx tsx scripts/smoke-slack-render.ts
```

Prints 15 rendered states to your terminal — anchor at every phase,
thread posts, approval messages, budget warning. Scroll through and
confirm everything looks readable. No DB or Slack involved; pure
functions.

### 6. Run a real test on dev

```bash
npm run dev
```

In your test client's Slack:

1. Trigger a multi-specialist task: `@bot run a quick audit`.
2. Watch the anchor message — should post immediately with "Starting
   up", then update to "Planning" with the specialists list as the
   orchestrator spawns them, then "Running specialists" with progress.
3. Click into the thread under the anchor. Each specialist completion
   should post a thread reply with that specialist's summary and token
   count.
4. Wait for aggregation. Anchor flips to "Synthesising", then
   "Complete". Final report posts in the thread.
5. Verify in Postgres:

   ```sql
   SELECT task_id, state->>'phase' AS phase,
          jsonb_array_length(jsonb_path_query_array(state->'specialists','$.*')) AS specialist_count,
          updated_at
     FROM slack_runs
    ORDER BY updated_at DESC LIMIT 5;
   ```

   Should show your test task's phase progressed correctly.

If you have a way to trigger a high-risk action that goes through HITL,
do so. Confirm a non-threaded approval request appears in the channel.
Approve it via the Sheet, watch for the resolution post.

Stop the local instance (Ctrl+C).

### 7. Apply the migration on prod

```bash
gcloud secrets versions access latest --secret="database-url" \
  --project=cgs-agent-shell-495221
# copy the URL output, then:
DATABASE_URL='<paste-prod-url>' npm run db:migrate
```

Verify the table exists in prod via Supabase SQL editor or the same
`\d slack_runs` query.

### 8. Push to main

```bash
git add .
git commit -m "feat: SlackPresenter (rollout 1) — anchor + threading + HITL post

- New: src/core/slack/{types,render,state-store,presenter,index}.ts
- New: db/migrate.ts adds slack_runs table
- Modified: orchestrator, aggregator, subagent, worker, hooks call
  presenter methods instead of raw postToSlack
- Modified: HookContext gains channelId so approvals post to the run's
  channel
- postToSlack tagged @deprecated; kept as escape hatch

Closes the multi-minute Slack silence during specialist work and the
HITL approval-without-Slack-notification gap."

git checkout main
git pull origin main
git merge feat/slack-presenter
git push origin main
```

Cloud Build kicks off. Watch in the GCP console under Cloud Build →
History. Build is a clean `npm run build` (no new deps, no Docker
changes), should be ~3–5 min.

### 9. Verify in production

```bash
gcloud run services logs tail cgs-agent-shell \
  --region=us-central1 --project=cgs-agent-shell-495221
```

Trigger a real client task in Slack. In the logs, look for:

- `slack_run_started { taskId: ..., anchorTs: ... }` at the start
- `subagent_spawned ...` per specialist
- `subagent_complete ...` and `subagent_failed ...` as they finish

In Supabase prod:

```sql
SELECT COUNT(*) FROM slack_runs WHERE created_at > NOW() - INTERVAL '1 hour';
```

Should be > 0.

Click through one of the anchor messages in Slack, click into the
thread, confirm thread posts are landing. If you can trigger an HITL
flow on a real client (carefully — pick a low-stakes one), confirm the
approval channel post appears.

### 10. Update ROADMAP

The ROADMAP.md in your project is stale. Open it and change the row for
"SlackPresenter" to `DEPLOYED`. Push:

```bash
git add ROADMAP.md
git commit -m "chore: SlackPresenter deployed to prod"
git push origin main
```

This kicks Cloud Build again — same code, just metadata. Fine.

### Phase 1 — done?

- [ ] `slack_runs` table exists in production
- [ ] Anchor message edits live in production (no 6+ minute silences)
- [ ] HITL approval flow posts a separate channel message
- [ ] `slack_runs` rows accumulating with new tasks
- [ ] No errors in Cloud Run logs for 1 hour after deploy
- [ ] ROADMAP updated

✅ Take a break. Let it bake for ~24 hours before starting Phase 2.

---

## Rollback

If something is wrong with this deploy, revert the merge:

```bash
git checkout main
git pull origin main
git revert -m 1 <merge-commit-sha>
git push origin main   # triggers redeploy of previous version
```

The `slack_runs` table stays in place — harmless when unused, and
preserving it avoids a re-run of the migration if you re-roll forward.

If you absolutely need to drop the table:

```sql
DROP TABLE IF EXISTS slack_runs;
```

The deprecated `postToSlack` function is still in `slackManager.ts`,
unused. Reverting the modified files brings back its callers; everything
will work as it did before.

---

## Common issues and fixes

**`slack_no_bot_for_tenant` warnings in logs.**

The presenter looked up `apps.get(tenantId)` and got nothing. Either the
tenant bot hasn't started yet (race at boot — should self-heal in
seconds) or the tenant is inactive. Check
`SELECT is_active FROM tenants WHERE tenant_id = '...';`.

**`slack_run_not_found` warnings.**

A presenter method was called for a `taskId` that has no `slack_runs`
row. Means `startRun` was either missed or failed. The most common
cause is `startRun`'s anchor post failing (rate limit, channel
permission), in which case the row isn't created and downstream calls
log this and move on. State is otherwise consistent — the agent's work
still completes, just without the live Slack updates.

**Anchor not updating, but DB state is correct.**

Slack edits failed (logged as `slack_edit_anchor_failed`). Most common:
the bot got removed from the channel, or rate-limited. State is
canonical in DB; retry by triggering another state change (e.g. another
specialist completing) and the next render will land.

**Two specialists complete simultaneously, anchor briefly shows the
older state.**

Known small race: A and B both finish, A's transaction commits first
with the V1 state, B's commits second with V2. If A's `chat.update`
arrives at Slack after B's, Slack briefly shows V1. The next state
change overwrites it. If this becomes visible to clients, the fix is to
re-fetch state right before each `chat.update` and skip if our revision
is stale — left as a follow-up because the race window is tiny in
practice (<200ms) relative to mutation rate (seconds-minutes apart).

**`HookContext` typecheck error in your custom code.**

I added the required `channelId: string` field. Find your call site and
add `channelId: task.slackChannelId` to the `hookCtx` object. The hook
needs the channel for approval messages.

---

## What changed for skill authors

Nothing, today. Skills don't interact with the presenter. The
behavioural change is entirely in the orchestration layer.

When skills start writing artifact changes (rollout 2 onward), the
hooks will route through the presenter automatically when high-risk
tools fire — no skill-level changes required.
