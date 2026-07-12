-- Daily digest schedule for Tarino. Run in Supabase SQL editor AFTER the
-- deploy containing the daily-digest commit and `npm run db:migrate`
-- (creates the daily_digests table + widens the run_kind CHECK).
--
-- The cycle is DB-only: writes one row per day to daily_digests
-- (payload JSONB + summary_md). Sends nothing. 17:00 Sydney, after both
-- generation runs have executed and their results have landed.

INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES ('tarino', 'daily_digest', '0 17 * * *', 'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind)
DO UPDATE SET cron_expr = EXCLUDED.cron_expr,
              timezone  = EXCLUDED.timezone,
              enabled   = true,
              updated_at = NOW();

-- Verify:
SELECT run_kind, cron_expr, enabled FROM tenant_schedules
 WHERE tenant_id = 'tarino' AND run_kind = 'daily_digest';

-- Read a digest after the first run:
-- SELECT digest_date, summary_md FROM daily_digests
--  WHERE tenant_id = 'tarino' ORDER BY digest_date DESC LIMIT 1;
-- Structured version:
-- SELECT digest_date, jsonb_pretty(payload) FROM daily_digests
--  WHERE tenant_id = 'tarino' ORDER BY digest_date DESC LIMIT 1;
