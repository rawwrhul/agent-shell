-- Tarino autonomous mode. Run in Supabase SQL editor AFTER the Cloud Run
-- deploy that includes db/migrations/tenant-autonomy.ts has gone live and
-- `npm run db:migrate` has been run (the migration creates the
-- autonomy_level column and widens the run_kind CHECK to allow 'daily_pm').
--
-- Effect:
--   - Tarino's executable propose_action approvals auto-approve and execute
--     immediately (resolved_by = '_autonomous_'). manual_operator_task and
--     outreach stay HITL.
--   - Blog publishes gate on the Surfer quality pipeline; failures fall back
--     to a Stage-2 human-review card.
--   - Second daily generation run at 14:00 Sydney: 2 articles/day total,
--     10-14 actions/day across both runs.

BEGIN;

UPDATE tenants
   SET autonomy_level = 'full',
       updated_at     = NOW()
 WHERE tenant_id = 'tarino';

INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES ('tarino', 'daily_pm', '0 14 * * *', 'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind)
DO UPDATE SET cron_expr = EXCLUDED.cron_expr,
              timezone  = EXCLUDED.timezone,
              enabled   = true,
              updated_at = NOW();

-- Optional: headroom for the heavier generation runs (1 article + 4-6
-- secondary actions each). Uncomment if runs start hitting the budget.
-- UPDATE tenants SET token_budget_per_run = 150000, updated_at = NOW()
--  WHERE tenant_id = 'tarino';

COMMIT;

-- Verify:
SELECT tenant_id, autonomy_level, token_budget_per_run
  FROM tenants WHERE tenant_id = 'tarino';
SELECT tenant_id, run_kind, cron_expr, timezone, enabled
  FROM tenant_schedules WHERE tenant_id = 'tarino' ORDER BY run_kind;

-- Rollback (instant, no deploy needed — takes effect within the 5-min
-- tenant cache TTL):
-- UPDATE tenants SET autonomy_level = 'hitl', updated_at = NOW() WHERE tenant_id = 'tarino';
-- UPDATE tenant_schedules SET enabled = false, updated_at = NOW() WHERE tenant_id = 'tarino' AND run_kind = 'daily_pm';
