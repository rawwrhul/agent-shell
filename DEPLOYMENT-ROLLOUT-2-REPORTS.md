# Rollout 2 — Block Kit + New Report Shapes + Memory Layer

**Goal:** three things landing as one coherent rollout —
1. Migrate Slack rendering to Block Kit.
2. Introduce two new report shapes (`daily-run`, `weekly-audit`) backed by 4 new SEO state tables.
3. Add the L1 + L2 memory layer (`run_scratchpad`, `tenant_memory`) so the agent compounds across runs.

The visual layer + content structure + cross-run memory ship together; the cron and CMS-MCP execution loops are tracked separately. **L3 (cross-tenant shared knowledge) is intentionally deferred** — its anonymisation/privacy design is its own focused rollout.

**Status:** ready to integrate. All new files are self-contained and pass `npm run typecheck`. Existing files (`render.ts`, `presenter.ts`, `types.ts`, `state-store.ts`, `index.ts`, plus the orchestrator and aggregator for memory wiring) need targeted updates — diffs below.

**Risk:** medium. The block-kit migration touches every Slack message the bot sends. The memory layer is purely additive — nothing reads from it until prompt-building code is updated to call `getMemoryContext()`. The new tables are additive (no risk to existing data). Roll out behind a feature flag if you want to A/B against current mrkdwn output for a day before fully cutting over.

---

## Inventory

### New files (12)

```
src/core/slack/blocks/
├── index.ts              ← barrel export
├── types.ts              ← block-specific types (RunType, RenderedMessage, report shapes)
├── shared.ts             ← block construction helpers
├── anchor.ts             ← run-in-progress anchor (Block Kit replacement)
├── thread-specialist.ts  ← per-specialist thread reply
├── thread-final.ts       ← ad-hoc final report (audit-style)
├── approval.ts           ← HITL approval request + resolution
├── daily-run.ts          ← NEW — daily run report
└── weekly-audit.ts       ← NEW — weekly audit report

src/seo/
├── types.ts              ← DB row + query types
└── data-store.ts         ← read/write for the 4 new SEO tables

src/memory/                ← NEW — L1 + L2 memory layer
├── index.ts              ← barrel export
├── types.ts              ← MemoryEntry, ScratchpadEntry, MemoryContext
├── store.ts              ← read/write for tenant_memory + run_scratchpad
└── context.ts            ← getMemoryContext + toPromptString

db/migrations/
├── 002-seo-tables.sql    ← 4 new SEO state tables + indexes
└── 003-memory-tables.sql ← NEW — tenant_memory + run_scratchpad

scripts/
├── smoke-blocks-render.ts   ← exercises every block render
└── smoke-memory-context.ts  ← NEW — exercises memory context assembly

DEPLOYMENT-ROLLOUT-2-REPORTS.md
```

### Modified files (7)

```
src/core/slack/render.ts        ← refactor to call new block builders, return RenderedMessage
src/core/slack/presenter.ts     ← send `blocks` (and text fallback) to chat.postMessage / chat.update
src/core/slack/types.ts         ← re-export RenderedMessage, RunType
src/core/slack/state-store.ts   ← (optional this rollout) helpers for SEO-flavoured runs
src/core/slack/index.ts         ← re-export new block module
src/orchestrator/index.ts       ← call getMemoryContext at run start, prepend to system prompt
src/agents/subagent.ts          ← provide read/write memory tools to specialists
package.json                    ← `smoke:blocks` and `smoke:memory` scripts
```

---

## Memory architecture (the three levels)

The memory layer is what turns the agent from a stateless executor into something that compounds across runs. Three levels, each with a clear scope:

**L1 — `run_scratchpad`** (in-task, this rollout)
The agent's working memory during a single run. Append-only. Use for caching tool results, intermediate observations, and decisions made mid-run that the agent might want to refer back to before the run ends. Pruned on a schedule via `scratchpadPrune()`. Lifetime: ~14 days then deleted.

**L2 — `tenant_memory` + the `seo_*` tables** (cross-run, single-tenant, this rollout)
The agent's long-term per-tenant brain. Two flavours:
- *Generic free-form* (`tenant_memory`): wins, losses, in-progress threads, learnings, decisions, constraints, preferences, facts. Upsert-on-(tenant, type, key) so the agent compounds rather than duplicates. Confidence rises on corroboration, decays on contradiction.
- *Structured SEO state* (`seo_work_log`, `seo_opportunities`, `seo_metrics_snapshots`, `seo_clusters`): typed, queryable, drives the daily/weekly reports.

Both are read at run start via `getMemoryContext()` and written during the run via tools the specialists call. Lifetime: indefinite, with confidence-based fadeout.

**L3 — `shared_knowledge`** (cross-tenant, **deferred to its own rollout**)
Anonymised patterns that benefit all tenants — "FAQPage schema typically lifts CTR 8–15% on commercial-intent SERPs across n=12 tenants." Promoted from L2 only when n≥5 and after passing anonymisation rules. Read-only for tenants. Not in this rollout because the privacy design (population thresholds, anonymisation, opt-in) needs its own pass.

### How memory feeds prompts

```
Run start:
  getMemoryContext(pool, { tenantId, taskType, seoSnapshot })
    → MemoryContext (curated slices of L1/L2 fitted to token budget)
  toPromptString(ctx)
    → "<tenant_memory>\n  <facts>...</facts>\n  <recent_wins>...</recent_wins>\n  ..."
  systemPrompt = memoryPromptString + "\n\n" + baseSystemPrompt

During run:
  Agent calls record_memory / scratchpad_write tools
    → writes to tenant_memory / run_scratchpad

Run end:
  Slack run completes; scratchpad rows linger for 14 days for debug
  Memory entries persist; next run reads them
```

---

## Step 1 — Branch and apply files

```bash
cd ~/Projects/CGSAgent/agent-shell-v3
git checkout main && git pull
git checkout -b feat/blocks-and-reports
unzip ~/Downloads/rollout2-blocks-and-reports.zip
git status
```

You should see all 14 files appear as new/modified. The block module is fully self-contained — nothing existing imports from it yet, so the only TypeScript-level impact comes from the 5 modifications below.

---

## Step 2 — Update `src/core/slack/render.ts`

The render module currently returns `string` (mrkdwn). Replace with the Block Kit equivalents.

**Before** (illustrative — the shape in your repo will be similar):

```ts
// renders run-in-progress anchor as mrkdwn
export function renderAnchor(state: RunState): string {
  // ...building mrkdwn lines
  return lines.join('\n');
}
```

**After:**

```ts
import {
  renderAnchor as renderAnchorBlocks,
  renderSpecialistThread,
  renderFinalReportThread,
  renderApprovalRequest,
  renderApprovalResolved,
  renderDailyRun,
  renderWeeklyAudit,
  type RenderedMessage,
  type AnchorState,
  type SpecialistThreadReply,
  type FinalReportThreadReply,
  type ApprovalRequest,
  type ApprovalResolution,
  type DailyRunReport,
  type WeeklyAuditReport,
} from './blocks';

export function renderAnchor(state: AnchorState): RenderedMessage {
  return renderAnchorBlocks(state);
}

// re-export the rest so existing call sites have a single import surface
export {
  renderSpecialistThread,
  renderFinalReportThread,
  renderApprovalRequest,
  renderApprovalResolved,
  renderDailyRun,
  renderWeeklyAudit,
};
export type {
  RenderedMessage,
  SpecialistThreadReply,
  FinalReportThreadReply,
  ApprovalRequest,
  ApprovalResolution,
  DailyRunReport,
  WeeklyAuditReport,
};
```

The existing `RunState` type from Rollout 1 will need a small adapter that maps it onto `AnchorState`. The fields are nearly identical — `phase`, `specialists`, `startedAt` — so a simple mapping function (10 lines, in `presenter.ts`) is enough. See Step 3.

---

## Step 3 — Update `src/core/slack/presenter.ts`

Two changes:

**(a)** Replace `text:` payloads with `text + blocks` payloads on every `chat.postMessage` and `chat.update` call. Bolt accepts both — `text` becomes the fallback for push notifications, `blocks` is the rich render.

**Before:**

```ts
await this.web.chat.update({
  channel,
  ts: anchor.ts,
  text: renderAnchor(state),
});
```

**After:**

```ts
const rendered = renderAnchor(toAnchorState(state));
await this.web.chat.update({
  channel,
  ts: anchor.ts,
  text: rendered.text,
  blocks: rendered.blocks,
});
```

**(b)** Add the small `RunState → AnchorState` adapter at the top of `presenter.ts`:

```ts
import type { AnchorState } from './blocks';
import type { RunState } from './types';

function toAnchorState(state: RunState): AnchorState {
  return {
    tenantName: state.tenantName,
    runId: state.runId,
    phase: state.phase,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt ?? new Date(),
    prompt: state.prompt,
    planSummary: state.planSummary,
    specialists: state.specialists.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,                 // pending | in_progress | done | failed
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      summary: s.summary,
    })),
    approvalPending: state.approvalPending
      ? {
          summary: state.approvalPending.summary,
          requestedAt: state.approvalPending.requestedAt,
        }
      : undefined,
    finalSummary: state.finalSummary,
    errorMessage: state.errorMessage,
  };
}
```

Repeat the same `text + blocks` pattern for:

- `recordSpecialistComplete` → call `renderSpecialistThread(...)`, post in thread with `thread_ts: anchor.ts`
- `completeRun` (when run is an ad-hoc audit) → call `renderFinalReportThread(...)`, post in thread
- `requestApproval` → call `renderApprovalRequest(...)`, post in **channel** (no thread_ts)
- `approvalResolved` → call `renderApprovalResolved(...)`, edit the original approval message via `chat.update`

For the new daily/weekly report types, add two new presenter methods:

```ts
async postDailyRun(channel: string, report: DailyRunReport): Promise<void> {
  const rendered = renderDailyRun(report);
  await this.web.chat.postMessage({
    channel,
    text: rendered.text,
    blocks: rendered.blocks,
  });
}

async postWeeklyAudit(channel: string, report: WeeklyAuditReport): Promise<void> {
  const rendered = renderWeeklyAudit(report);
  await this.web.chat.postMessage({
    channel,
    text: rendered.text,
    blocks: rendered.blocks,
  });
}
```

Both post to the channel (not threaded) — these are checkpoint reports, not in-progress updates.

---

## Step 4 — Update `src/core/slack/index.ts`

Re-export the block module so callers have one import path:

```ts
export * from './render';
export * from './presenter';
export * from './blocks';   // NEW
```

---

## Step 5 — DB migration

```bash
# Dev first
npm run db:migrate
```

Confirm the four new tables exist:

```bash
psql "$DATABASE_URL" -c "\dt seo_*"
# Expected:
#   seo_clusters
#   seo_metrics_snapshots
#   seo_opportunities
#   seo_work_log
```

Quick sanity write/read:

```sql
INSERT INTO seo_work_log (id, tenant_id, run_id, action_type, summary, status)
VALUES (gen_random_uuid(), 'tarino', gen_random_uuid(), 'audit_run', 'smoke test', 'success');

SELECT id, tenant_id, summary, executed_at FROM seo_work_log;
DELETE FROM seo_work_log WHERE summary = 'smoke test';
```

---

## Step 6 — Smoke test

```bash
# package.json — add the script
"smoke:blocks": "tsx scripts/smoke-blocks-render.ts"
```

Run it:

```bash
npm run smoke:blocks
```

Expected: 10 renders, all "✓ rendered N blocks", trailing `✓ All 10 renders passed.`

To eyeball any of the renders in Slack's Block Kit Builder:

```bash
npm run smoke:blocks > /tmp/blocks.json
# open /tmp/blocks.json, copy any blocks[] array, paste into:
# https://app.slack.com/block-kit-builder/
```

Visually verify:

- **anchor (running)** — header reads "Tarino · Running", specialist list shows one done / one in-progress / one pending
- **daily / typical** — sections appear in order: Shipped overnight → New opportunities → Queued for today → Awaiting approval → footer
- **weekly / typical** — state-of-play scorecard shows 6 fields in a 2-col grid, top 3 priorities, cluster progress, risk flags
- **approval / requested** — three buttons (Approve & publish / Reject / Defer)

---

## Step 7 — Production migration

Same pattern as Rollout 1 — pull DATABASE_URL from Secret Manager, run the migration manually:

```bash
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="database-url" \
  --project=cgs-agent-shell-495221) \
  npm run db:migrate
```

Both `002-seo-tables.sql` and `003-memory-tables.sql` apply in one run.

Verify in Supabase: Table Editor → confirm all six new tables present, each with the expected indexes:

- `seo_clusters`
- `seo_metrics_snapshots`
- `seo_opportunities`
- `seo_work_log`
- `tenant_memory` (with `tenant_memory_tenant_type_key_unique` constraint visible)
- `run_scratchpad`

Spot-check the `tenant_memory` UPDATE trigger (`trg_tenant_memory_touch`) is registered: Database → Triggers in Supabase, search "tenant_memory".

---

## Step 8 — Deploy and verify

```bash
git add .
git commit -m "feat: block kit migration + daily/weekly report shapes (rollout 2)"
git push origin feat/blocks-and-reports
# open PR → review → merge to main
# Cloud Build deploys automatically
```

Watch the build, wait for the new revision to go live, then trigger a test run from the dev workspace:

```
@tarino do a quick check
```

Expected:
1. Anchor message posts with **Block Kit layout** (header block, specialist list, footer context)
2. Anchor edits in place as phases progress (planning → running → synthesising → complete)
3. Final report posts in thread with proper section structure

Screenshot the new layout and check it against `tarino-report-mocks.html` for parity.

---

## Step 9 — Wire memory into the orchestrator and specialists

The memory layer is the difference between an agent that compounds and one that resets every run. Two integration points:

### 9a — Orchestrator: assemble memory at run start

In `src/orchestrator/index.ts`, at the top of the run handler (after the tenant + task type are resolved, before the system prompt is built):

```ts
import { getMemoryContext, toPromptString } from '../memory';
import { getSeoMemorySnapshot } from '../seo/data-store';

// ... existing run setup ...

// Pull SEO snapshot if this is an SEO-shaped run
const seoSnapshot = isSeoRun(taskType)
  ? await getSeoMemorySnapshot(pool, tenantId)
  : undefined;

const memoryContext = await getMemoryContext(pool, {
  tenantId,
  taskType,
  seoSnapshot,
  tokenBudget: 1500,
});

const memoryPrompt = toPromptString(memoryContext);

// Prepend to the system prompt for orchestrator + every specialist:
const systemPrompt = `${memoryPrompt}\n\n${baseSystemPrompt}`;
```

`getSeoMemorySnapshot()` is a small helper to add to `src/seo/data-store.ts` — it queries the existing seo_* tables and returns a compact `SeoMemorySnapshot`. Reference shape:

```ts
export async function getSeoMemorySnapshot(pool: Pool, tenantId: string): Promise<SeoMemorySnapshot> {
  const [shipped, opps, approval, clusters] = await Promise.all([
    queryRecentWorkLog(pool, tenantId, 10),
    queryOpenOpportunities(pool, tenantId, 8),
    queryAwaitingApproval(pool, tenantId),
    queryClusterProgress(pool, tenantId),
  ]);
  return { recentlyShipped: shipped, openOpportunities: opps, awaitingApproval: approval, clusterProgress: clusters };
}
```

### 9b — Specialists: read/write memory through tools

Each specialist gets four tools wired into its tool list (defined in `src/agents/subagent.ts`):

```ts
import { recordMemory, queryMemory, scratchpadAppend, scratchpadReadAll } from '../memory';

// Tool definitions (anthropic tool format):
const memoryTools = [
  {
    name: 'record_memory',
    description: 'Persist a learning, win, loss, decision, or constraint about this tenant. Use sparingly — only for facts worth carrying into future runs.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['win','loss','in_progress','learning','decision','constraint','preference','fact'] },
        key: { type: 'string', description: 'Stable handle (kebab-case). Re-using a key updates the existing entry.' },
        value: { type: 'string', description: 'The thing to remember, in your own words.' },
        confidence: { type: 'number', description: '0..1, default 0.5' },
      },
      required: ['type', 'key', 'value'],
    },
  },
  {
    name: 'query_memory',
    description: 'Read this tenant\'s prior memories. Filter by type to narrow scope.',
    input_schema: { /* type, limit */ },
  },
  {
    name: 'scratchpad_write',
    description: 'Save an intermediate observation to this run\'s scratchpad. Use for tool results you want to refer back to mid-run.',
    input_schema: { /* key, value */ },
  },
  {
    name: 'scratchpad_read',
    description: 'Read everything in this run\'s scratchpad so far.',
    input_schema: { /* (none) */ },
  },
];
```

Bind the handlers to call `recordMemory(pool, ...)`, `queryMemory(pool, ...)`, `scratchpadAppend(pool, ...)`, `scratchpadReadAll(pool, runId)` respectively. Pass `runId` and `tenantId` as closure-captured context so the agent can't accidentally write to the wrong tenant.

### 9c — Verify the loop closes

After 9a + 9b are deployed, run two consecutive `@tarino` invocations. On the first, watch the agent call `record_memory` (Cloud Run logs will show the tool call). On the second, the system prompt should now include a populated `<tenant_memory>` block — verify by adding a debug log right before the API call.

If the second run's prompt has no memory block, check:
1. `tenant_memory` table actually has rows (`SELECT * FROM tenant_memory WHERE tenant_id = 'tarino'`)
2. The orchestrator's `getMemoryContext()` call is actually being awaited (not fire-and-forget)
3. The token budget isn't trimming everything (raise to 3000 to test)

---

## Step 10 — Wire the daily/weekly reports

The block builders are deployed but won't fire until something calls them. Two ways to wire this:

**Wire A (manual, ship today):** Add a Slack command `/tarino run` and `/tarino audit` that triggers `postDailyRun` / `postWeeklyAudit` with whatever data is currently in `seo_work_log` etc. On a fresh tenant, the empty-state copy in the renders handles the "no data yet" case gracefully.

**Wire B (cron, separate ticket):** Add a BullMQ repeatable job per tenant. The job runs the agent, the agent logs to `seo_work_log` / `seo_opportunities`, then `postDailyRun` posts the result. This is the eventual shape.

Either way, the data side is the gating dependency — the agent has to actually write to the new tables. That's the domain of the SEO skill (separate rollout). The visual layer this rollout ships is ready to render whatever data you point it at.

---

## What this rollout does NOT include

To keep scope clean:

- **No L3 (cross-tenant shared knowledge).** The `shared_knowledge` table, the L2→L3 promotion pipeline, and the anonymisation/generalisation rules ship as a separate focused rollout. L3 has real privacy implications (small populations leak); rushing it would be costly to fix.
- **No cron infrastructure.** Cron triggering is a separate piece, blocked on architecture decisions about per-tenant scheduling config and BullMQ repeatable jobs.
- **No SEO skill.** The agent doesn't yet know to log structured actions to `seo_work_log`. Until the skill ships, the daily/weekly reports will render empty-state messaging.
- **No CMS MCP wiring.** Agent execution against Framer/CMS is downstream — when the skill exists, it'll wire to whichever MCP servers are available per tenant.
- **No HITL action handler routing.** The approval blocks include button `action_id`s (`approval_approve`, `approval_reject`, `approval_defer`) but the Bolt action handler that processes button clicks is unchanged from Rollout 1. If Rollout 1 didn't wire approve/reject, the buttons will still post but won't resolve the approval. Track that as a separate ticket.

---

## Rollback

If the Block Kit render breaks something in production, the rollback is a single revert:

```bash
git revert <merge-commit-sha>
git push origin main
```

Cloud Build redeploys the previous revision in ~2 minutes. The DB tables stay (they're additive and unused until rollout step 9 wires them), so no DB rollback needed.

---

## Definition of done

- [ ] `npm run typecheck` clean
- [ ] `npm run smoke:blocks` passes — all 10 renders ✓
- [ ] `npm run smoke:memory` passes — all 3 memory contexts assemble ✓
- [ ] Dev migration applied — both `002` and `003` SQL files
- [ ] Prod migration applied and verified in Supabase (6 new tables, 1 trigger)
- [ ] Cloud Run revision deployed
- [ ] Test run @-mention in dev workspace shows Block Kit layout
- [ ] Anchor edits in place through phases (verify `(edited)` marker)
- [ ] Smoke-render output pasted into Block Kit Builder for daily / weekly — visually matches mocks
- [ ] First `@tarino` call records at least one row to `tenant_memory`
- [ ] Second `@tarino` call's system prompt includes a populated `<tenant_memory>` block (verify via log)
- [ ] Scratchpad rows visible in `run_scratchpad` after a multi-tool run

When all checked, close the ticket and create the follow-up tickets:
- Cron + per-tenant scheduling
- SEO skill + structured logging tools
- HITL action handler routing
- L3 shared_knowledge (with anonymisation/promotion design)
