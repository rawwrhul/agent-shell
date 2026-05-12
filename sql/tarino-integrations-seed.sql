-- tarino-integrations-seed.sql
--
-- Run this AFTER 20260512-integrations-and-executions.sql to wire up
-- tarino's integration config. Adjust the values per the actual property
-- IDs and URLs.

BEGIN;

-- Enable integrations for tarino.
-- Order doesn't matter; list is the set of integrations whose TOOLS the
-- subagent should see when running for this tenant.
UPDATE tenants
   SET integrations = '["framer", "gsc", "ga4", "dataforseo"]'::jsonb
 WHERE tenant_id = 'tarino';

-- Set the Google integration property IDs (non-secret).
-- VERIFY these values against the tenant's actual GSC + GA4 + Framer setup
-- before running this update.
UPDATE tenants
   SET gsc_site_url       = 'sc-domain:tarino.au',                            -- or 'https://tarino.au/' if URL-prefix property
       ga4_property_id    = 'REPLACE_WITH_GA4_PROPERTY_ID',                   -- numeric, from GA4 admin
       framer_project_url = 'REPLACE_WITH_FRAMER_PROJECT_URL'                 -- https://framer.com/projects/Sites--xxx
 WHERE tenant_id = 'tarino';

-- Confirm:
SELECT tenant_id, integrations, gsc_site_url, ga4_property_id, framer_project_url
  FROM tenants
 WHERE tenant_id = 'tarino';

COMMIT;

-- Credentials (Framer API key, DataForSEO login:password) are stored separately
-- via the set-credential script — NOT in this SQL.
