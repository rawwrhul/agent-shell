// src/memory/context.ts
//
// Assembles the prepend-to-prompt memory string for a given tenant +
// task type. This is the *one* function every skill/specialist calls
// to inject continuity into its work. Don't call queryMemory directly
// from prompt-building code — go through here so the slicing,
// truncation, and ordering rules stay consistent.

import type { Pool } from 'pg';
import { queryMemory } from './store';
import { retrieveRelevant } from './vector';
import type { MemoryContext, MemoryEntry, SeoMemorySnapshot, SemanticRecallEntry } from './types';

// ── Public API ──────────────────────────────────────────────────────

export interface GetMemoryContextOptions {
  tenantId: string;
  taskType: string;
  /**
   * Optional caller-supplied SEO snapshot. The memory module doesn't
   * import the SEO data store directly — keeps the dependency arrow
   * one-way. Caller (orchestrator) builds the snapshot if it's
   * relevant to the task and passes it in.
   */
  seoSnapshot?: SeoMemorySnapshot;
  /**
   * Soft budget — how many tokens of memory we're willing to spend.
   * The assembler trims entries to fit. Default 1500.
   */
  tokenBudget?: number;
  /**
   * Phase 4 Lever 3 — if supplied, run a vector-similarity recall over
   * agent_learnings and surface the most *relevant* (not most recent) past
   * outcomes. Typically the task/draft text (e.g. subTask.task, task.prompt).
   * Omit to skip semantic recall entirely.
   */
  semanticQuery?: string;
  /** Max semantic-recall hits to surface. Default 3. */
  semanticTopK?: number;
  /** Minimum cosine similarity to surface a hit. Default 0.35. */
  semanticMinSimilarity?: number;
}

export async function getMemoryContext(
  pool: Pool,
  opts: GetMemoryContextOptions
): Promise<MemoryContext> {
  const { tenantId, taskType, seoSnapshot } = opts;
  const budget = opts.tokenBudget ?? 1500;

  // Limits per slice. Tunable. We pull more than we'll use, then trim
  // by token budget after assembly.
  const limits = {
    win: 8,
    loss: 5,
    in_progress: 10,
    learning: 10,
    constraint: 10,
    preference: 10,
    fact: 8,
  };

  const [
    wins,
    losses,
    inProgress,
    learnings,
    constraints,
    preferences,
    facts,
  ] = await Promise.all([
    queryMemory(pool, { tenantId, type: 'win', limit: limits.win }),
    queryMemory(pool, { tenantId, type: 'loss', limit: limits.loss }),
    queryMemory(pool, { tenantId, type: 'in_progress', limit: limits.in_progress }),
    queryMemory(pool, { tenantId, type: 'learning', limit: limits.learning }),
    queryMemory(pool, { tenantId, type: 'constraint', limit: limits.constraint }),
    queryMemory(pool, { tenantId, type: 'preference', limit: limits.preference }),
    queryMemory(pool, { tenantId, type: 'fact', limit: limits.fact }),
  ]);

  const ctx: MemoryContext = {
    tenantId,
    taskType,
    recentWins: wins,
    recentLosses: losses,
    inProgress,
    learnings,
    constraints,
    preferences,
    facts,
    seoSnapshot,
    estimatedTokens: 0, // filled in below
  };

  // Semantic recall (Lever 3): the past outcomes most *similar* to this task,
  // not just the most recent. Best-effort — retrieveRelevant swallows its own
  // errors and returns []. Deduped against the recency slices so an outcome
  // isn't shown twice.
  if (opts.semanticQuery) {
    const minSim = opts.semanticMinSimilarity ?? 0.35;
    const hits = await retrieveRelevant({
      tenantId,
      query: opts.semanticQuery,
      topK: opts.semanticTopK ?? 3,
    });
    const recencyText = [...wins, ...losses].map((e) => e.value);
    const recall: SemanticRecallEntry[] = hits
      .filter((h) => h.similarity >= minSim)
      .filter((h) => !recencyText.some((v) => overlaps(v, h.content)))
      .map((h) => ({
        content: h.content,
        similarity: h.similarity,
        kind: typeof h.metadata?.kind === 'string' ? (h.metadata.kind as string) : undefined,
      }));
    if (recall.length > 0) ctx.semanticRecall = recall;
  }

  ctx.estimatedTokens = estimateTokens(ctx);

  // If over budget, trim least-confident entries until we fit.
  if (ctx.estimatedTokens > budget) {
    trimToFit(ctx, budget);
  }

  return ctx;
}

// ── Prompt formatting ───────────────────────────────────────────────

/**
 * Render the memory context as a string suitable for prepending to a
 * system prompt. Uses an XML-tag wrapper because models attend to
 * tagged sections more reliably than free-form prose.
 */
export function toPromptString(ctx: MemoryContext): string {
  const sections: string[] = [];

  if (ctx.facts.length > 0) {
    sections.push(formatSection('facts', ctx.facts));
  }
  if (ctx.constraints.length > 0) {
    sections.push(formatSection('constraints', ctx.constraints));
  }
  if (ctx.preferences.length > 0) {
    sections.push(formatSection('preferences', ctx.preferences));
  }
  if (ctx.recentWins.length > 0) {
    sections.push(formatSection('recent_wins', ctx.recentWins));
  }
  if (ctx.recentLosses.length > 0) {
    sections.push(formatSection('recent_losses', ctx.recentLosses));
  }
  if (ctx.inProgress.length > 0) {
    sections.push(formatSection('in_progress', ctx.inProgress));
  }
  if (ctx.learnings.length > 0) {
    sections.push(formatSection('learnings', ctx.learnings));
  }
  if (ctx.semanticRecall && ctx.semanticRecall.length > 0) {
    sections.push(formatSemanticRecall(ctx.semanticRecall));
  }
  if (ctx.seoSnapshot) {
    sections.push(formatSeoSnapshot(ctx.seoSnapshot));
  }

  if (sections.length === 0) {
    return `<tenant_memory>\n  <empty>This is the agent's first run for this tenant. No prior memory.</empty>\n</tenant_memory>`;
  }

  return `<tenant_memory>\n${sections.join('\n')}\n</tenant_memory>`;
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Render the semantic-recall slice. Each line leads with the outcome kind
 * (so the model knows whether it's an "avoid this" or "this worked" signal)
 * and the similarity, so a marginally-relevant hit reads as lower-weight.
 */
function formatSemanticRecall(entries: SemanticRecallEntry[]): string {
  const lines = entries.map((e) => {
    const tag = e.kind ? `[${e.kind}] ` : '';
    const sim = `(relevance ${e.similarity.toFixed(2)})`;
    return `    - ${tag}${e.content} ${sim}`;
  });
  return `  <relevant_recall>\n${lines.join('\n')}\n  </relevant_recall>`;
}

/**
 * Cheap textual dedup: treat two entries as the same outcome if either
 * contains the other (covers the common case where a recent loss and its
 * semantic-recall twin share the same proposed-action text).
 */
function overlaps(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

function formatSection(tag: string, entries: MemoryEntry[]): string {
  const lines = entries.map((e) => {
    const conf = formatConfidence(e.confidence, e.evidenceCount);
    return `    - ${e.value} ${conf}`;
  });
  return `  <${tag}>\n${lines.join('\n')}\n  </${tag}>`;
}

function formatConfidence(confidence: number, evidenceCount: number): string {
  // Only annotate when the signal is meaningful — strong confirmation or
  // active doubt. Middle-of-the-road confidence is left unannotated to
  // keep the prompt compact.
  if (confidence >= 0.85 && evidenceCount >= 3) return `[strong, n=${evidenceCount}]`;
  if (confidence < 0.4) return `[uncertain]`;
  return '';
}

function formatSeoSnapshot(s: SeoMemorySnapshot): string {
  const sections: string[] = [];
  if (s.recentlyShipped.length > 0) {
    sections.push(
      `    <recently_shipped>\n${s.recentlyShipped
        .map((a) => `      - ${a.title} (${a.status}, ${a.executedAt.toISOString().slice(0, 10)})`)
        .join('\n')}\n    </recently_shipped>`
    );
  }
  if (s.openOpportunities.length > 0) {
    sections.push(
      `    <open_opportunities>\n${s.openOpportunities
        .map((o) => `      - [${o.priority}] ${o.description}`)
        .join('\n')}\n    </open_opportunities>`
    );
  }
  if (s.awaitingApproval.length > 0) {
    sections.push(
      `    <awaiting_approval>\n${s.awaitingApproval
        .map((a) => `      - ${a.title} (pending since ${a.pendingSince.toISOString().slice(0, 10)})`)
        .join('\n')}\n    </awaiting_approval>`
    );
  }
  if (s.clusterProgress.length > 0) {
    sections.push(
      `    <cluster_progress>\n${s.clusterProgress
        .map((c) => `      - ${c.pillar}: ${c.landed}/${c.total} briefs landed`)
        .join('\n')}\n    </cluster_progress>`
    );
  }
  if (sections.length === 0) return '';
  return `  <seo_state>\n${sections.join('\n')}\n  </seo_state>`;
}

/**
 * Rough token estimate — 1 token ≈ 4 chars for English-ish text. Good
 * enough for budget enforcement; not worth pulling in tiktoken.
 */
function estimateTokens(ctx: MemoryContext): number {
  const all = [
    ...ctx.recentWins,
    ...ctx.recentLosses,
    ...ctx.inProgress,
    ...ctx.learnings,
    ...ctx.constraints,
    ...ctx.preferences,
    ...ctx.facts,
  ];
  const memoryChars = all.reduce((acc, e) => acc + e.value.length + 30, 0);
  const recallChars = (ctx.semanticRecall ?? []).reduce((acc, e) => acc + e.content.length + 30, 0);
  const seoChars = ctx.seoSnapshot ? estimateSeoSnapshotChars(ctx.seoSnapshot) : 0;
  return Math.ceil((memoryChars + recallChars + seoChars) / 4);
}

function estimateSeoSnapshotChars(s: SeoMemorySnapshot): number {
  return (
    s.recentlyShipped.reduce((a, x) => a + x.title.length + 40, 0) +
    s.openOpportunities.reduce((a, x) => a + x.description.length + 20, 0) +
    s.awaitingApproval.reduce((a, x) => a + x.title.length + 40, 0) +
    s.clusterProgress.reduce((a, x) => a + x.pillar.length + 30, 0)
  );
}

/**
 * If we're over budget, drop the lowest-confidence entries until we
 * fit. We never trim constraints or preferences — those are
 * load-bearing for behavioural alignment. We trim from learnings,
 * losses, then wins, in that order.
 */
function trimToFit(ctx: MemoryContext, tokenBudget: number): void {
  // Semantic recall is the most expendable — it's a "nice to have relevance"
  // signal, not load-bearing. Drop its lowest-similarity entries first.
  while (ctx.estimatedTokens > tokenBudget && ctx.semanticRecall && ctx.semanticRecall.length > 0) {
    let lowestIdx = 0;
    for (let i = 1; i < ctx.semanticRecall.length; i++) {
      if (ctx.semanticRecall[i].similarity < ctx.semanticRecall[lowestIdx].similarity) lowestIdx = i;
    }
    ctx.semanticRecall.splice(lowestIdx, 1);
    if (ctx.semanticRecall.length === 0) ctx.semanticRecall = undefined;
    ctx.estimatedTokens = estimateTokens(ctx);
  }
  if (ctx.estimatedTokens <= tokenBudget) return;

  const trimOrder: Array<keyof Pick<MemoryContext, 'learnings' | 'recentLosses' | 'recentWins' | 'facts'>> = [
    'learnings',
    'recentLosses',
    'recentWins',
    'facts',
  ];

  for (const slice of trimOrder) {
    while (ctx.estimatedTokens > tokenBudget && ctx[slice].length > 0) {
      // Drop the lowest-confidence entry
      const arr = ctx[slice];
      let lowestIdx = 0;
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].confidence < arr[lowestIdx].confidence) lowestIdx = i;
      }
      arr.splice(lowestIdx, 1);
      ctx.estimatedTokens = estimateTokens(ctx);
    }
    if (ctx.estimatedTokens <= tokenBudget) return;
  }
  // If still over (constraints/preferences/in_progress alone exceed
  // budget), we leave them as-is. Caller can detect via estimatedTokens
  // and decide whether to widen the budget for this run.
}
