-- hd-quoting-seed.sql
--
-- HD Level 2 Electrician — quoting tenant registration runbook.
--
-- This is a RUNBOOK, not a hand-INSERT. The canonical registration path is
-- `npm run onboard`, which writes the tenant row with the correct
-- Secret-Manager name convention (${tenantId}-slack-bot-token, etc.) — do not
-- hand-insert the row and bypass that convention.
--
-- Registration sequence (run the shell/CLI steps in your terminal; this file
-- holds only the SQL verification step, per the house rule that SQL and shell
-- never share a block):
--
--   1. Create the per-tenant Slack secrets in Secret Manager:
--        hd-electrician-slack-bot-token
--        hd-electrician-slack-app-token
--        hd-electrician-slack-signing-secret
--        hd-electrician-hitl-spreadsheet-id   (unused by quoting; set to a
--                                               placeholder so onboard's insert
--                                               doesn't choke on a missing secret)
--        hd-electrician-google-sa-email        (placeholder for MVP)
--        hd-electrician-google-private-key     (placeholder for MVP)
--      (HITL for quoting runs through Slack approval cards, not a Sheet, so the
--       Google/Sheet secrets are placeholders in the MVP — quoting never reads
--       them. Revisit if a Sheet audit mirror is wanted later.)
--
--   2. Run onboarding:
--        npm run onboard
--      Answer:
--        Tenant ID:    hd-electrician
--        Client name:  HD Level 2 Electrician
--        Agent type:   quoting
--        Billing tag:  hd-electrician
--        Skills:       (leave empty — quoting bypasses the SEO skills loader)
--        Slack channel ID: <the #quotes channel in HD's workspace>
--
--   3. Add the client credential (delivery email) + confirm shared transcription key:
--        npm run onboard:creds hd-electrician     -> electrician_email
--        npm run setup:cgs                         -> assemblyai_api_key (shared)
--        npm run creds:check hd-electrician        -> expect electrician_email ✅
--
--   4. Apply 20260608-quoting-1-foundation.sql in the Supabase SQL editor
--      (creates the `quotes` table).
--
--   5. Verify the tenant row landed correctly (run THIS query in Supabase):

SELECT tenant_id,
       client_name,
       agent_type,
       is_active,
       skills,
       slack_channel_id,
       billing_tag
  FROM tenants
 WHERE tenant_id = 'hd-electrician';

-- Expect: agent_type = 'quoting', is_active = true, skills = '[]'.
--
-- Quoting needs NO integrations / gsc_site_url / ga4_property_id / framer
-- config, so there is no post-registration UPDATE here (unlike the tarino
-- seed). The rate card, PDF branding (licence no., ASP accreditation, ABN),
-- and the checklist/upsell registry are seeded TS config modules under
-- src/agents/quoting/config/, NOT database rows, for the MVP.
