#!/usr/bin/env tsx
// scripts/smoke-memory-context.ts
//
// Verifies the memory context assembler produces well-formed XML-tagged
// prompt prefixes for a range of tenant states. Pure-function — no DB
// required. Run via:
//
//   npm run smoke:memory
//
// Pipe the output into Claude or an LLM playground to sanity-check that
// the assembled context reads cleanly when prepended to a system prompt.

import { toPromptString } from '../src/memory';
import type {
  MemoryContext,
  MemoryEntry,
  SeoMemorySnapshot,
} from '../src/memory';

const NOW = new Date('2026-05-13T09:02:00+10:00');
const TENANT = 'tarino';

// ── Fixture builder ─────────────────────────────────────────────────

function entry(
  type: MemoryEntry['type'],
  key: string,
  value: string,
  confidence = 0.7,
  evidenceCount = 1
): MemoryEntry {
  return {
    id: `mem-${key}`,
    tenantId: TENANT,
    type,
    key,
    value,
    confidence,
    evidenceCount,
    sourceRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// ── Case 1: rich context (typical mid-engagement tenant) ────────────

const seoSnapshot: SeoMemorySnapshot = {
  recentlyShipped: [
    {
      title: 'FAQPage schema added to homepage',
      executedAt: new Date('2026-05-13T02:14:00+10:00'),
      status: 'success',
    },
    {
      title: 'Meta descriptions rewritten on /about and /contact-page',
      executedAt: new Date('2026-05-13T02:31:00+10:00'),
      status: 'success',
    },
  ],
  openOpportunities: [
    { description: '/pricing has no schema · est. 12% CTR lift', priority: 'P1' },
    { description: '"offshore accountant Australia" cluster gap', priority: 'P1' },
  ],
  awaitingApproval: [
    {
      title: 'Publish cluster page #1',
      pendingSince: new Date('2026-05-11T08:00:00+10:00'),
    },
  ],
  clusterProgress: [
    { pillar: 'Hire offshore in Australia', landed: 3, total: 12 },
  ],
};

const richContext: MemoryContext = {
  tenantId: TENANT,
  taskType: 'daily_run',
  recentWins: [
    entry('win', 'faq-schema-homepage-ctr',
      'FAQPage schema on homepage lifted CTR ~12% over 3 weeks.', 0.9, 4),
    entry('win', 'internal-link-pricing',
      'Internal link consolidation on /resources moved /pricing from #14 to #8.', 0.85, 3),
  ],
  recentLosses: [
    entry('loss', 'long-form-blog-traffic',
      '4000-word blog post on /resources/why-offshore got <50 visits in 30 days. Shorter, more specific cluster pages outperform.', 0.6),
  ],
  inProgress: [
    entry('in_progress', 'pillar-1-cluster-build',
      'Building 12-cluster architecture under "Hire offshore in Australia" pillar. 3 of 12 briefs landed; cluster #4 (bookkeeper) drafting today.', 0.8, 2),
    entry('in_progress', 'aeo-reddit-push',
      '4 Reddit answers drafted for AEO citation play; awaiting approval before posting.'),
  ],
  learnings: [
    entry('learning', 'audience-converts-on-rates',
      'Tarino\'s audience converts better on landing pages with explicit hourly rate breakdowns vs vague "save up to 70%" claims.', 0.75),
    entry('learning', 'framer-deploy-manual',
      'Schema additions on Framer require manual deployment review — auto-publish via API is unreliable.', 0.85, 3),
  ],
  constraints: [
    entry('constraint', 'organic-only',
      'No paid advertising integration — organic SEO + AEO only.', 1.0, 5),
    entry('constraint', 'voice-direct-no-fluff',
      'Brand voice: direct, professional, no corporate fluff. No buzzwords like "leverage", "synergy", "best-in-class".', 0.95, 4),
  ],
  preferences: [
    entry('preference', 'australian-spelling',
      'Use Australian English spelling throughout (optimise, organisation, colour).', 1.0, 6),
  ],
  facts: [
    entry('fact', 'pricing-model',
      'Tarino charges A$5,000+GST one-time fee per offshore hire (not retainer).', 1.0, 8),
    entry('fact', 'icp-vertical',
      'Primary ICP is Australian professional services firms — accounting, financial planning, mortgage broking.', 0.95, 5),
  ],
  seoSnapshot,
  estimatedTokens: 0,
};
richContext.estimatedTokens = roughTokens(richContext);

// ── Case 2: empty context (first run for a new tenant) ──────────────

const emptyContext: MemoryContext = {
  tenantId: 'newclient',
  taskType: 'daily_run',
  recentWins: [],
  recentLosses: [],
  inProgress: [],
  learnings: [],
  constraints: [],
  preferences: [],
  facts: [],
  estimatedTokens: 0,
};

// ── Case 3: constraints-only (early engagement, briefed but not run) ─

const briefedOnlyContext: MemoryContext = {
  tenantId: 'briefed',
  taskType: 'on_demand',
  recentWins: [],
  recentLosses: [],
  inProgress: [],
  learnings: [],
  constraints: [
    entry('constraint', 'organic-only', 'Organic only. No paid.', 1.0, 1),
  ],
  preferences: [
    entry('preference', 'tone-direct', 'Tone: direct and grounded.', 1.0, 1),
  ],
  facts: [
    entry('fact', 'icp', 'B2B SaaS targeting mid-market in APAC.', 1.0, 1),
  ],
  estimatedTokens: 0,
};
briefedOnlyContext.estimatedTokens = roughTokens(briefedOnlyContext);

// ── Run + report ────────────────────────────────────────────────────

const cases = [
  { name: 'rich (mid-engagement tenant)',     ctx: richContext },
  { name: 'empty (first run)',                 ctx: emptyContext },
  { name: 'briefed only (early engagement)',   ctx: briefedOnlyContext },
];

let failCount = 0;
for (const c of cases) {
  const banner = `── ${c.name} ` + '─'.repeat(Math.max(0, 60 - c.name.length));
  process.stdout.write(`\n${banner}\n`);
  const promptString = toPromptString(c.ctx);
  process.stdout.write(`estimated tokens: ${c.ctx.estimatedTokens}\n\n`);
  process.stdout.write(`${promptString}\n`);

  const failures: string[] = [];
  if (!promptString.startsWith('<tenant_memory>')) {
    failures.push('output must start with <tenant_memory>');
  }
  if (!promptString.endsWith('</tenant_memory>')) {
    failures.push('output must end with </tenant_memory>');
  }
  // Empty case should still produce a well-formed wrapper.
  if (c.ctx.recentWins.length === 0 && c.ctx.constraints.length === 0 &&
      c.ctx.facts.length === 0 && c.ctx.preferences.length === 0 &&
      !promptString.includes('<empty>')) {
    failures.push('empty context should include <empty> child node');
  }

  if (failures.length > 0) {
    failCount++;
    for (const f of failures) process.stdout.write(`  ✗ FAIL — ${f}\n`);
  } else {
    process.stdout.write(`  ✓ well-formed\n`);
  }
}

const summary = failCount === 0
  ? `\n✓ All ${cases.length} memory contexts assembled cleanly.\n`
  : `\n✗ ${failCount} of ${cases.length} cases failed.\n`;

process.stdout.write(summary);
process.exit(failCount === 0 ? 0 : 1);

// ── Helpers ─────────────────────────────────────────────────────────

function roughTokens(ctx: MemoryContext): number {
  const all = [
    ...ctx.recentWins, ...ctx.recentLosses, ...ctx.inProgress,
    ...ctx.learnings, ...ctx.constraints, ...ctx.preferences, ...ctx.facts,
  ];
  return Math.ceil(all.reduce((acc, e) => acc + e.value.length + 30, 0) / 4);
}
