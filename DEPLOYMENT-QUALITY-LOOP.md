# DEPLOYMENT — Quality loop for autonomous runs

Five upgrades that move autonomous-run quality from "plausible actions" to
"measured, gated, criticized actions." All deterministic gates fail open on
missing data and blocked-on-evidence only. HITL tenants are unchanged except
where noted.

## What changed

**1. Per-action outcome scoring (`src/skills/seo-outcomes/`)**
New `outcome_score` run kind (silent, no LLM, no Slack). For every executed
approval targeting a page (source of truth: `approval_requests.executed_at` +
`tool_input` — worker-set, not model-supplied), it measures GSC
clicks/impressions/position for the target URL 14d and 28d before vs after
execution, against the rest of the site as control (diff-in-diff-lite).
Deterministic verdicts (`scoring.ts`, conservative thresholds) are written to
`tenant_memory` as `win`/`loss` (neutral → `learning`, low confidence), keys
`outcome-{N}d-{approvalId8}`. Each (approval, window) scored exactly once.
The daily generation prompt now instructs the agent to query `win`/`loss`
memories first and weight them above all other priors — the
ship→measure→policy loop, closed.

**2. Cannibalization guard (`src/skills/seo/cannibalization.ts`)**
Server-side, all tenants, on `approve_blog_pitch` filings: slug collision
against `seo_page_inventory`; title near-duplicate (normalized-token Jaccard
≥ 0.6, stopwords stripped); target-keyword overlap — an existing page with
≥50 impressions at position ≤20 for the pitch keyword in the last 28 days
blocks the pitch and redirects the agent to improve that page instead. The
pitch spec now requires `targetKeyword` in toolInput (also feeds the Surfer
gate, which previously fell back to the title).

**3. Guidelines-first drafting (`src/agents/subagent.ts` Phase B.1b)**
The drafter must pull `surfer_content_guidelines` (terms, word count,
structure) and review the top 2-3 ranking pages BEFORE writing, since the
publish gate scores against the same Surfer editor. Raises first-pass gate
pass rate; fewer discards. Requires `'surfer'` in the tenant integrations
array (ship SQL adds it for Tarino).

**4. Edit gates for non-article actions (`src/skills/seo/edit-gates.ts`)**
Autonomous tenants only, at propose_action time: title 30-65 chars, meta
description 70-165, no generic anchor text; duplicate-title check site-wide;
internal-link target must exist in the crawl inventory; **protect winners**
(clicks up ≥25% and ≥10 clicks over the last 14d → content changes blocked);
**churn cap** (max 2 executed edits per page per 30 days).

**5. Critic pass (`src/skills/seo/critic.ts`) + quality floor**
Autonomous tenants, auto-executable tools: one adversarial LLM call per
filing whose only job is to find the reason NOT to ship (ungrounded,
off-lane vs business brief, risky, pointless). Runs after the deterministic
gates, before the approval row exists — rejects leave no state and return
actionable feedback to the agent. Fails open on API/parse errors. Generation
prompts now set a quality floor instead of a quota: "up to" N actions, 3
grounded beats 7 padded.

## Order of gates at propose_action (autonomous)

pitch validation (image/links) → cannibalization → edit gates → critic →
createApproval → auto-approve → execute. Articles additionally face the
Surfer quality pipeline at the executor.

## Deploy sequence

1. Push to main, wait for green.
2. `npm run db:migrate` (adds `outcome_score` to the run_kind CHECK — the
   tenant-autonomy migration is idempotent and re-runs).
3. Supabase SQL editor: `sql/20260712-quality-loop.sql`. This also adds a
   **metrics_sync schedule Tarino was missing** — without it ranking_history
   is empty and outcome scoring / protect-winners / keyword-overlap are
   blind (they fail open, so no breakage, just no value).
4. Restart/redeploy so the scheduler registers `metrics_sync` and
   `outcome_score` repeatables. Verify `schedule_registered` log lines.

## Verify in production

- After first `metrics_sync` (05:30): `SELECT COUNT(*) FROM ranking_history
  WHERE tenant_id='tarino'` > 0.
- After first `outcome_score` (07:00): `outcome_cycle_completed` log. Verdicts
  need ≥14 days of post-execution history — early runs will scan and skip;
  first real win/loss memories appear ~2 weeks after actions started shipping.
- Generation runs: `seo_propose_action_critic_rejected` and
  `seo_propose_action_edit_gate_failed` log lines when gates catch things;
  `CANNIBALIZATION` errors in run output when topics collide.
- `tenant_memory`: `SELECT * FROM tenant_memory WHERE tenant_id='tarino' AND
  key LIKE 'outcome-%'` (after the 2-week ramp).

## Verification run locally

`npx tsc --noEmit` clean; `npx vitest run` 172/172 (32 new tests across
outcome scoring, cannibalization similarity, edit-gate bounds, critic
parsing). Sole failing test FILE remains the pre-existing
`src/skills/ads/tools.test.ts` missing-module import (commit 7b4b779).

## Notes

- Outcome thresholds live in `src/skills/seo-outcomes/scoring.ts` and are
  deliberately conservative (a false 'win' becomes bad policy). Tune there.
- The critic uses `tenant.agentModel`; there is no premium-model constant in
  the codebase. If you later want Opus-class judgment on the critic only,
  add a `CRITIC_MODEL` override in `critic.ts`.
- ranking_history GSC sync pulls a trailing 5-day window; the outcome
  cycle's 14/28-day windows therefore only have full data for actions
  executed AFTER metrics_sync started running. Historical actions score
  from partial history — expect mostly 'neutral' verdicts for those.
