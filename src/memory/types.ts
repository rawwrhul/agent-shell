// src/memory/types.ts
//
// Three-level memory architecture:
//   L1 — run_scratchpad   (in-task, agent's working memory during one run)
//   L2 — tenant_memory    (cross-run, scoped to one tenant)
//   L3 — shared_knowledge (cross-tenant, anonymised; separate rollout)
//
// L1 + L2 ship in this rollout. L3 is intentionally deferred — its
// privacy/anonymisation design needs its own pass.

// ── L2: tenant_memory ───────────────────────────────────────────────

/**
 * The kinds of long-term memory we maintain per tenant.
 * Kept narrow and well-typed so prompts can pull just the right slices.
 */
export type MemoryType =
  | 'win'           // something that worked — keep doing it
  | 'loss'          // something that failed — avoid repeating
  | 'in_progress'   // open thread of work waiting for next run
  | 'learning'      // observation about this tenant's market/audience/site
  | 'decision'      // a strategic call we made and want to honour
  | 'constraint'    // something we cannot do (brand, legal, technical)
  | 'preference'    // tenant style preferences (voice, format, channels)
  | 'fact';         // ground-truth fact about the tenant we want to remember

export interface MemoryEntry {
  id: string;
  tenantId: string;
  type: MemoryType;
  /** Short stable handle so we can update existing entries without dupes. */
  key: string;
  /** Human-readable content, fed verbatim into prompts. */
  value: string;
  /**
   * 0..1 — how confident we are in this entry. Bumped on corroboration,
   * decayed when contradicted.
   */
  confidence: number;
  /** How many runs have corroborated this entry. */
  evidenceCount: number;
  /** Last run that touched this entry. Useful for traceability. */
  sourceRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Input shape for recording a new memory. ID/timestamps assigned by the store. */
export interface MemoryInput {
  tenantId: string;
  type: MemoryType;
  key: string;
  value: string;
  confidence?: number;       // default 0.5
  sourceRunId?: string;
}

export interface MemoryQuery {
  tenantId: string;
  type?: MemoryType;
  /** Limit per type. Default 20. */
  limit?: number;
  /**
   * If true, ignore entries with confidence below 0.25 — stale beliefs
   * we've started doubting. Default true.
   */
  excludeLowConfidence?: boolean;
}

// ── L1: run_scratchpad ──────────────────────────────────────────────

/**
 * The scratchpad is append-only working memory tied to one run.
 * Use it for: caching tool results, recording intermediate findings,
 * tracking decisions the agent makes mid-run. NOT a substitute for
 * tenant_memory — anything worth keeping past the run gets explicitly
 * promoted via record_memory.
 */
export interface ScratchpadEntry {
  id: string;
  runId: string;
  /** Free-form key — agent decides the namespace. */
  key: string;
  /** JSON-serialisable. Tool outputs, intermediate decisions, etc. */
  value: unknown;
  createdAt: Date;
}

export interface ScratchpadInput {
  runId: string;
  key: string;
  value: unknown;
}

// ── Assembled context (what gets prepended to prompts) ──────────────

/**
 * The fully-assembled memory context for a run.
 * `getMemoryContext(tenantId, taskType)` returns this; renderers / prompt
 * builders call `.toPromptString()` to slot it into a system prompt.
 */
export interface MemoryContext {
  tenantId: string;
  taskType: string;            // 'daily_run' | 'weekly_audit' | 'on_demand' | 'audit' | …

  // Curated slices from L2
  recentWins: MemoryEntry[];
  recentLosses: MemoryEntry[];
  inProgress: MemoryEntry[];
  learnings: MemoryEntry[];
  constraints: MemoryEntry[];
  preferences: MemoryEntry[];
  facts: MemoryEntry[];

  // Optional: rolled-up SEO state from the structured-L2 tables
  // (populated by getMemoryContext when it can reach the SEO data store)
  seoSnapshot?: SeoMemorySnapshot;

  /** Approximate token cost of this context if dropped into a prompt. */
  estimatedTokens: number;
}

/**
 * Compact rollup of SEO-specific structured memory — the high-level
 * state of play surfaced into prompts so the agent has continuity
 * without having to query the structured tables itself.
 */
export interface SeoMemorySnapshot {
  recentlyShipped: Array<{ title: string; executedAt: Date; status: string }>;
  openOpportunities: Array<{ description: string; priority: string }>;
  awaitingApproval: Array<{ title: string; pendingSince: Date }>;
  clusterProgress: Array<{ pillar: string; landed: number; total: number }>;
}
