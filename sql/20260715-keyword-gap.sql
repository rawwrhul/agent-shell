-- 20260715-keyword-gap.sql — schedule the keyword_gap origination cycle.
-- PREREQUISITE: `npm run db:migrate` has run (creates seo.keyword_gap and
-- widens the tenant_schedules run_kind CHECK to allow 'keyword_gap').
--
-- Weekly, 02:00 Sydney Monday — an hour before the discovery cycles and
-- ahead of the weekly strategy_refresh, so the strategist and the copy/meta
-- cycles always see fresh gap rows. Ahrefs spend is capped by the 30-day
-- vendor cache: one organic-keywords report per competitor per 30 days.

INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES
  ('hd-seo', 'keyword_gap', '0 2 * * 1', 'Australia/Sydney', true),
  ('tarino', 'keyword_gap', '15 2 * * 1', 'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind)
DO UPDATE SET cron_expr = EXCLUDED.cron_expr,
              timezone  = EXCLUDED.timezone,
              enabled   = true,
              updated_at = NOW();

SELECT tenant_id, run_kind, cron_expr, enabled
FROM tenant_schedules
WHERE run_kind = 'keyword_gap';
