-- 20260725-bank-drain.sql — schedule the bank_drain executor.
-- PREREQUISITE: `npm run db:migrate` has run (widens run_kind CHECK).
--
-- 07:00 Sydney daily for hd-seo — after the discovery cycles (06:00-06:35)
-- refresh the bank, before the 08:15 daily generation run. Ships up to 20
-- banked on-page actions (12 meta + 8 links) per day through the full gate
-- chain. Tarino gets a row too but DISABLED until the Framer adapter lands
-- (v1 executor is Webflow-only).

INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES
  ('hd-seo', 'bank_drain', '0 7 * * *', 'Australia/Sydney', true),
  ('tarino', 'bank_drain', '30 7 * * *', 'Australia/Sydney', false)
ON CONFLICT (tenant_id, run_kind)
DO UPDATE SET cron_expr = EXCLUDED.cron_expr,
              timezone  = EXCLUDED.timezone,
              enabled   = EXCLUDED.enabled,
              updated_at = NOW();

SELECT tenant_id, run_kind, cron_expr, enabled
FROM tenant_schedules WHERE run_kind = 'bank_drain';
