// src/memory/context.ts
//
// Assembles the prepend-to-prompt memory string for a given tenant +
// task type. This is the *one* function every skill/specialist calls
// to inject continuity into its work. Don't call queryMemory directly
// from prompt-building code — go through here so the slicing,
// truncation, and ordering rules stay consistent.

import type { Pool } from 'pg';
import { queryMemory } from './store';
import type { MemoryContext, MemoryEntry, SeoMemorySnapshot } from './types';

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
  if (ctx.seoSnapshot) {
    sections.push(formatSeoSnapshot(ctx.seoSnapshot));
  }

  if (sections.length === 0) {
    return `<tenant_memory>\n  <empty>This is the agent's first run for this tenant. No prior memory.</empty>\n</tenant_memory>`;
  }

  return `<tenant_memory>\n${sections.join('\n')}\n</tenant_memory>`;
}

// ── Internals ───────────────────────────────────────────────────────

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
  const seoChars = ctx.seoSnapshot ? estimateSeoSnapshotChars(ctx.seoSnapshot) : 0;
  return Math.ceil((memoryChars + seoChars) / 4);
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
