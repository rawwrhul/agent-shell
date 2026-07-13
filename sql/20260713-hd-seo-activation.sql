-- hd-seo tenant activation (High Demand Electrical, Webflow).
-- Run in Supabase SQL editor AFTER:
--   1. deploy containing the Webflow integration is green
--   2. `npm run db:migrate` has run (adds webflow_site_id column)
--   3. `npm run onboard` has registered the 'hd-seo' tenant (Slack secrets
--      must exist in GCP Secret Manager first: hd-seo-slack-bot-token,
--      hd-seo-slack-app-token, hd-seo-slack-signing-secret)
--   4. Webflow site token stored:
--      npx tsx scripts/set-credential.ts hd-seo webflow "<site token>"
--
-- Replace <WEBFLOW_SITE_ID> below (Webflow dashboard → Site settings →
-- General → Site ID, or GET https://api.webflow.com/v2/sites with the token).

BEGIN;

UPDATE tenants
   SET integrations       = '["webflow","gsc","dataforseo","pexels","surfer","ahrefs"]'::jsonb,
       gsc_site_url       = 'sc-domain:hdlevel2electriciansydney.com.au',
       webflow_site_id    = '<WEBFLOW_SITE_ID>',
       target_domain      = 'www.hdlevel2electriciansydney.com.au',
       cms_path_prefixes  = ARRAY['/resources/'],
       autonomy_level     = 'full',
       updated_at         = NOW()
 WHERE tenant_id = 'hd-seo';

INSERT INTO tenant_schedules (tenant_id, run_kind, cron_expr, timezone, enabled)
VALUES
  ('hd-seo', 'metrics_sync',       '35 5 * * *', 'Australia/Sydney', true),
  ('hd-seo', 'outcome_score',      '5 7 * * *',  'Australia/Sydney', true),
  ('hd-seo', 'daily',              '15 8 * * *', 'Australia/Sydney', true),
  ('hd-seo', 'daily_pm',           '15 14 * * *','Australia/Sydney', true),
  ('hd-seo', 'daily_digest',       '15 17 * * *','Australia/Sydney', true),
  ('hd-seo', 'seo_audit',          '30 0 * * 6', 'Australia/Sydney', true),
  ('hd-seo', 'strategy_refresh',   '15 6 * * 1', 'Australia/Sydney', true),
  ('hd-seo', 'backlink_prospect',  '30 2 * * 0', 'Australia/Sydney', true),
  ('hd-seo', 'brand_mention_scan', '30 4 * * 0', 'Australia/Sydney', true),
  ('hd-seo', 'metadata_edit',      '15 3 * * *', 'Australia/Sydney', true),
  ('hd-seo', 'copy_optimise',      '45 3 * * *', 'Australia/Sydney', true),
  ('hd-seo', 'internal_link',      '15 4 * * *', 'Australia/Sydney', true)
ON CONFLICT (tenant_id, run_kind)
DO UPDATE SET cron_expr = EXCLUDED.cron_expr,
              timezone  = EXCLUDED.timezone,
              enabled   = true,
              updated_at = NOW();

COMMIT;

-- Verify:
SELECT tenant_id, agent_type, autonomy_level, target_domain, webflow_site_id, integrations
  FROM tenants WHERE tenant_id = 'hd-seo';
SELECT run_kind, cron_expr, enabled FROM tenant_schedules
 WHERE tenant_id = 'hd-seo' ORDER BY run_kind;

-- NOTE: crons are staggered 15-45 min off Tarino's to avoid two tenants'
-- generation runs contending for the same worker + token budget window.
--
-- Rollback to HITL (instant, 5-min cache):
-- UPDATE tenants SET autonomy_level = 'hitl', updated_at = NOW() WHERE tenant_id = 'hd-seo';
