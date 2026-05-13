-- sql/20260514-task-0_5-daily-generation.sql
--
-- Schema additions for Task 0.5 — daily generation cron + Framer
-- draft-first approvals. Three migrations folded into one idempotent
-- file. Run BEFORE deploying the corresponding code.
--
-- 1. Extend task_intent enum on subtasks to include 'daily_generation'.
--    Cron-daily trigger uses this new intent so the subagent gets bigger
--    token + iteration budgets and the generation-first prompt section.
--
-- 2. Add preview_url column to approval_requests. Set by propose_action
--    when the agent has prepared a Framer draft. The Slack approval card
--    renderer already supports previewUrl (line 33 of approval.ts).
--
-- 3. Add competitor_domains column to tenants. Used by the daily
--    generation prompt as the seed list for pillars 1 (new pages) and
--    4 (backlinks). Defaults to empty array; agent can fall back to
--    DataForSEO competitor discovery if the list is empty.

BEGIN;

-- 1. task_intent: add 'daily_generation' to the constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subtasks'
      AND constraint_name = 'subtasks_task_intent_check'
  ) THEN
    ALTER TABLE subtasks DROP CONSTRAINT subtasks_task_intent_check;
  END IF;

  ALTER TABLE subtasks
    ADD CONSTRAINT subtasks_task_intent_check
    CHECK (task_intent IN ('investigate', 'propose_changes', 'execute_approved', 'daily_generation'));
END$$;

-- 2. approval_requests.preview_url
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS preview_url TEXT;

-- 3. tenants.competitor_domains
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS competitor_domains TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMIT;
