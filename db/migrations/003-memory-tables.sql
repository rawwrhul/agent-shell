-- db/migrations/003-memory-tables.sql
--
-- Rollout 2 (memory layer): tenant_memory + run_scratchpad.
--
-- These ship alongside 002-seo-tables.sql. Together they form the
-- compounding layer: the agent reads its prior wins/losses/learnings
-- and the SEO state at run start, and writes new memory at run end.
--
-- Idempotent — safe to re-run.

-- ── tenant_memory (L2: generic, free-form per-tenant memory) ────────
-- The agent's long-term per-tenant brain. Stores wins, losses,
-- in-progress threads, learnings, decisions, constraints, preferences,
-- and ground-truth facts. Rendered into the system prompt at run start
-- via getMemoryContext() in src/memory/context.ts.

CREATE TABLE IF NOT EXISTS tenant_memory (
  id              UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN
                    ('win','loss','in_progress','learning','decision',
                     'constraint','preference','fact')),
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  confidence      NUMERIC(3,2) NOT NULL DEFAULT 0.50
                    CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count  INT NOT NULL DEFAULT 1,
  source_run_id   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_memory_tenant_type_key_unique
    UNIQUE (tenant_id, type, key)
);

-- Most reads are "all entries of type X for tenant Y, recent first".
CREATE INDEX IF NOT EXISTS idx_tenant_memory_tenant_type_updated
  ON tenant_memory (tenant_id, type, updated_at DESC);

-- Confidence filter is applied on every read; partial index keeps reads cheap.
CREATE INDEX IF NOT EXISTS idx_tenant_memory_confident
  ON tenant_memory (tenant_id, type, updated_at DESC)
  WHERE confidence >= 0.25;

-- ── run_scratchpad (L1: in-task working memory) ─────────────────────
-- Append-only log of intermediate observations the agent records
-- during a single run. Distinct from slack_runs.state (which is the
-- current snapshot of run progress) — scratchpad accumulates without
-- bloating that hot-path JSONB column.
--
-- Pruned on a schedule via scratchpadPrune() in src/memory/store.ts.

CREATE TABLE IF NOT EXISTS run_scratchpad (
  id          UUID PRIMARY KEY,
  run_id      UUID NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_scratchpad_run_created
  ON run_scratchpad (run_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_run_scratchpad_run_key
  ON run_scratchpad (run_id, key);

-- ── Touch trigger: bump updated_at on tenant_memory updates ─────────
-- The store does this in SQL explicitly, but a trigger keeps the
-- invariant true even if a future migration UPDATEs rows directly.

CREATE OR REPLACE FUNCTION touch_tenant_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_memory_touch ON tenant_memory;
CREATE TRIGGER trg_tenant_memory_touch
  BEFORE UPDATE ON tenant_memory
  FOR EACH ROW
  EXECUTE FUNCTION touch_tenant_memory_updated_at();
