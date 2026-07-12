-- Quality loop for Tarino autonomous mode. Run in Supabase SQL editor AFTER
-- the deploy containing the quality-loop commit is green and
-- `npm run db:migrate` has run (adds 'outcome_score' to the run_kind CHECK).
--
-- Three data changes:
--   1. metrics_sync schedule — Tarino doesn't have one. ranking_history is
--      EMPTY without it, which blinds the outcome loop, protect-winners
--      gate, and keyword-overlap check (they all fail open). 05:30 daily.
--   2. outcome_score schedule — 07:00 daily, after metrics_sync, before the
--      08:00 generation run consumes the win/loss memories.
--   3. 'surfer' added to Tarino's integrations array so the agent gets the
--      surfer_content_guidelines tool for guidelines-first drafting
--      (append-if-absent; does not clobber the existing array).

BEGIN;

INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES
  ('tarino', 'metrics_sync',  '30 5 * * *', 'Australia/Sydney', true),
  ('tarino', 'outcome_score', '0 7 * * *',  'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind)
DO UPDATE SET cron_expr = EXCLUDED.cron_expr,
              timezone  = EXCLUDED.timezone,
              enabled   = true,
              updated_at = NOW();

UPDATE tenants
   SET integrations = CASE WHEN integrations ? 'surfer'
                           THEN integrations
                           ELSE integrations || '["surfer"]'::jsonb END,
       updated_at   = NOW()
 WHERE tenant_id = 'tarino';

COMMIT;

-- Verify:
SELECT run_kind, cron_expr, enabled
  FROM tenant_schedules
 WHERE tenant_id = 'tarino' AND run_kind IN ('metrics_sync', 'outcome_score');
SELECT tenant_id, integrations FROM tenants WHERE tenant_id = 'tarino';

-- After the first outcome_score run (needs ~14 days of shipped actions +
-- ranking history before it produces verdicts):
-- SELECT type, key, value, confidence FROM tenant_memory
--  WHERE tenant_id = 'tarino' AND key LIKE 'outcome-%' ORDER BY updated_at DESC LIMIT 20;
