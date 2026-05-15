-- 20260515-phase8-two-stage-approval.sql
--
-- Two-stage approval flow: Stage 1 (approve_blog_pitch) creates a draft in
-- Framer + queues Stage 2 (framer_confirm_publish). Stage 2 row links back
-- to Stage 1 via parent_approval_id so the chain is traceable.
--
-- Also enables thread-replies for approval cards (no schema change required;
-- presenter looks up the anchor_ts from slack_runs by task_id).

BEGIN;

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS parent_approval_id UUID REFERENCES approval_requests(id);

CREATE INDEX IF NOT EXISTS idx_approval_parent ON approval_requests (parent_approval_id)
  WHERE parent_approval_id IS NOT NULL;

COMMIT;
