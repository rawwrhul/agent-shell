-- sql/20260513-task-intent-and-reconciliation.sql
--
-- Adds task_intent to subtasks so the orchestrator can selectively grant
-- write capability to specialists.
--
-- Idempotent. Run BEFORE deploying the corresponding code change, so that
-- existing INSERTs without explicit task_intent fall through to the
-- column default and the new code's column reference is satisfied.
--
-- Values:
--   'investigate'      — read-only mode. Tool builder strips propose_action,
--                        log_seo_action, snapshot_metrics, upsert_cluster.
--   'propose_changes'  — current default. Full SEO_TOOLS, can file approvals.
--   'execute_approved' — reserved for future use. Today, execution is routed
--                        through the executor worker post-approval, not by
--                        the agent directly.

ALTER TABLE subtasks
  ADD COLUMN IF NOT EXISTS task_intent TEXT NOT NULL DEFAULT 'propose_changes';

-- Light validation. Reject unknown values at insert time so a typo from
-- the orchestrator doesn't silently become 'propose_changes'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.constraint_column_usage
    WHERE table_name = 'subtasks'
      AND column_name = 'task_intent'
      AND constraint_name = 'subtasks_task_intent_check'
  ) THEN
    ALTER TABLE subtasks
      ADD CONSTRAINT subtasks_task_intent_check
      CHECK (task_intent IN ('investigate', 'propose_changes', 'execute_approved'));
  END IF;
END$$;

-- Index used by reconciliation baseline capture, which filters by tenant
-- + task_id + a time window. Existing indexes cover tenant + status; this
-- one accelerates the cross-table reconciliation queries.
CREATE INDEX IF NOT EXISTS idx_subtasks_tenant_task_created
  ON subtasks (tenant_id, parent_task_id, created_at);
