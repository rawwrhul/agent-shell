-- sql/20260514-task-0_5_1-polish.sql
--
-- Schema additions for Task 0.5.1 — customer-experience polish on top
-- of Task 0.5 (daily generation + Framer drafts).
--
-- Two pieces, both idempotent:
--
-- 1. Extend subtasks task_intent CHECK to include the two new weekly
--    intents — 'weekly_audit' (strategic state-of-play, fires Monday
--    morning) and 'weekly_digest' (celebratory wins recap, fires
--    Friday afternoon).
--
-- 2. Add approval_requests.last_nudged_at — when the pending-too-long
--    scanner most recently posted a reminder for this approval. Used
--    to enforce the once-per-24h cooldown so we don't spam tenants.

BEGIN;

-- 1. task_intent enum extension
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
    CHECK (task_intent IN (
      'investigate',
      'propose_changes',
      'execute_approved',
      'daily_generation',
      'weekly_audit',
      'weekly_digest'
    ));
END$$;

-- 2. approval_requests.last_nudged_at
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS last_nudged_at TIMESTAMPTZ;

-- Partial index speeds up the pending-nudge scanner's main query: it
-- only ever looks at status='pending' rows that haven't been recently
-- nudged. Full table scan would be wasteful as approval_requests grows.

COMMIT;
