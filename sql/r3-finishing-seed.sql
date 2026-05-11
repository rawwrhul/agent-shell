-- r3-finishing-seed.sql
--
-- Seeds the tenant_schedules table with daily and weekly cron rows for the
-- tarino tenant. Apply this AFTER the R3-finishing deploy goes live.
--
-- Crons:
--   daily   → 08:00 Australia/Sydney every day
--   weekly  → 08:00 Australia/Sydney every Monday
--
-- Cron expression notes:
--   `0 8 * * *`      — at 08:00 every day
--   `0 8 * * 1`      — at 08:00 every Monday (1 = Monday in standard cron)
--   Timezone is interpreted by BullMQ's RepeatOptions.tz when scheduled.
--
-- Idempotency: ON CONFLICT DO NOTHING means re-running this is a no-op.
-- If you want to *change* the time, run the UPDATE block at the bottom.

-- ── Insert tarino schedules ───────────────────────────────────────────────

INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES
  ('tarino', 'daily',  '0 8 * * *', 'Australia/Sydney', true),
  ('tarino', 'weekly', '0 8 * * 1', 'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind) DO NOTHING;

-- ── Verify ────────────────────────────────────────────────────────────────

SELECT tenant_id, run_kind, cron_expr, timezone, enabled, created_at
  FROM tenant_schedules
 WHERE tenant_id = 'tarino'
 ORDER BY run_kind;


-- ── If you need to change an existing schedule (uncomment + edit) ─────────
--
-- UPDATE tenant_schedules
--    SET cron_expr = '0 9 * * *',
--        timezone  = 'Australia/Sydney',
--        updated_at = now()
--  WHERE tenant_id = 'tarino'
--    AND run_kind  = 'daily';


-- ── Adding schedules for a new tenant later ───────────────────────────────
--
-- Copy the INSERT block above, swap 'tarino' for the new tenant_id.
-- Add a target_domain column update too if relevant:
--
-- UPDATE tenants
--    SET target_domain = 'newclient.com.au',
--        cron_timezone = 'Australia/Sydney'
--  WHERE tenant_id = '<new-tenant-id>';
