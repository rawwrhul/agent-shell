#!/usr/bin/env tsx
// scripts/smoke-blocks-render.ts
//
// Renders every Block-Kit-producing function with realistic Tarino-flavoured
// input data and prints the resulting JSON. Lets you eyeball the output and
// optionally pipe it into Slack's Block Kit Builder for visual confirmation:
//
//   npm run smoke:blocks > /tmp/blocks.json
//   # then paste any blocks[] array into https://app.slack.com/block-kit-builder/
//
// All outputs are validated against the @slack/web-api KnownBlock type at
// compile time. Any TS type error here means the render contracts are off.

import {
  renderAnchor,
  renderSpecialistThread,
  renderFinalReportThread,
  renderApprovalRequest,
  renderApprovalResolved,
  renderDailyRun,
  renderWeeklyAudit,
  type AnchorState,
  type SpecialistThreadReply,
  type FinalReportThreadReply,
  type ApprovalRequest,
  type ApprovalResolution,
  type DailyRunReport,
  type WeeklyAuditReport,
  type RenderedMessage,
} from '../src/core/slack/blocks';

const NOW = new Date('2026-05-13T09:02:00+10:00');         // Wed 13 May 2026, 9:02am AEST
const RUN_ID = '7d092763-ff35-451f-9355-3079b598b06b';

// ── Anchor ──────────────────────────────────────────────────────────

const anchorRunning: AnchorState = {
  tenantName: 'Tarino',
  runId: RUN_ID,
  phase: 'running',
  startedAt: new Date(NOW.getTime() - 4 * 60_000),
  updatedAt: NOW,
  prompt: 'Run a daily SEO sweep and surface anything high-leverage.',
  planSummary: 'Spawn 3 specialists: SEO Auditor, Cluster Analyst, AEO Scout.',
  specialists: [
    {
      id: 'sp1',
      name: 'SEO Auditor',
      status: 'done',
      startedAt: new Date(NOW.getTime() - 3 * 60_000),
      finishedAt: new Date(NOW.getTime() - 90_000),
      summary: 'Surfaced 3 schema gaps + 1 internal link opportunity.',
    },
    {
      id: 'sp2',
      name: 'Cluster Analyst',
      status: 'in_progress',
      startedAt: new Date(NOW.getTime() - 80_000),
    },
    {
      id: 'sp3',
      name: 'AEO Scout',
      status: 'pending',
    },
  ],
};

const anchorComplete: AnchorState = {
  ...anchorRunning,
  phase: 'complete',
  updatedAt: new Date(NOW.getTime() + 90_000),
  specialists: anchorRunning.specialists.map((s) => ({
    ...s,
    status: 'done',
    startedAt: s.startedAt ?? new Date(NOW.getTime() - 60_000),
    finishedAt: new Date(NOW.getTime() + 30_000),
    summary:
      s.summary ??
      (s.name === 'Cluster Analyst'
        ? 'Drafted brief #3 of 12 for the offshore-hiring-AU pillar.'
        : 'Drafted Reddit answer for r/AusFinance citation play.'),
  })),
  finalSummary: '5 actions shipped · 3 opportunities surfaced · 2 pending approval',
};

const anchorAwaitingApproval: AnchorState = {
  ...anchorRunning,
  phase: 'running',
  approvalPending: {
    summary: 'Publish cluster page #1 to /resources/how-to-hire-offshore-australia',
    requestedAt: new Date(NOW.getTime() - 30_000),
  },
};

// ── Specialist thread reply ─────────────────────────────────────────

const specialistReply: SpecialistThreadReply = {
  specialistName: 'SEO Auditor',
  status: 'done',
  summary: 'Found 3 schema gaps and 1 internal link opportunity on tarino.au.',
  details:
    '*Schema gaps*\n' +
    '• `/` — FAQPage missing on the homepage FAQ block (11 Q&A pairs)\n' +
    '• `/pricing` — Product/Offer schema missing on pricing block\n' +
    '• `/about` — Organization schema thin\n\n' +
    '*Internal link*\n' +
    '• `/#how-we-hire` orphan path → `/resources` hub (anchor: "structured offshore hiring process")',
  artifacts: [
    { label: 'Audit JSON', url: 'https://workspace.example/audits/2026-05-13.json' },
  ],
  startedAt: new Date(NOW.getTime() - 3 * 60_000),
  finishedAt: new Date(NOW.getTime() - 90_000),
};

// ── Final report (ad-hoc audit) ─────────────────────────────────────

const finalReport: FinalReportThreadReply = {
  headline: 'Tarino — Site Audit Summary',
  sections: [
    {
      title: 'Headline',
      body:
        'Tarino is well-positioned for topical authority on offshore hiring for AU professional services. ' +
        'Foundations are in place; the next 5 weeks of work compound on the homepage cluster.',
    },
    {
      title: 'Top opportunities',
      body:
        '• Pillar-and-cluster on "Hire offshore in Australia" (12 cluster briefs targeted)\n' +
        '• Schema markup on /pricing (Product/Offer) — highest commercial intent\n' +
        '• Reddit + LinkedIn AEO push for brand-mention citations',
    },
    {
      title: 'What to monitor',
      body:
        'Hammerjack added 3 pillar pages in the last week. Topic gap is widening. ' +
        'Recommend increasing cluster cadence to 2 briefs/week from 1.',
    },
  ],
  artifacts: [
    { label: 'Full audit doc', url: 'https://workspace.example/tarino/audit-2026-05-13' },
    { label: 'Cluster plan',   url: 'https://workspace.example/tarino/cluster-plan' },
  ],
  meta: {
    totalSpecialists: 3,
    totalTokens: 184_320,
    elapsedMs: 6 * 60_000 + 12_000,
  },
};

// ── Approval request ────────────────────────────────────────────────

const approvalReq: ApprovalRequest = {
  tenantName: 'Tarino',
  runId: RUN_ID,
  approvalId: 'apr_h2pb0xq3',
  actionKind: 'publish_content',
  summary: 'Publish cluster page #1 to /resources/how-to-hire-offshore-australia',
  detail:
    "*Page:* `/resources/how-to-hire-offshore-australia`\n" +
    '*Word count:* 2,340\n' +
    '*Target keyword:* "how to hire offshore staff Australia"\n' +
    '*Internal links:* 4 inbound (homepage, /pricing, /resources, /#how-we-hire)\n\n' +
    'On approval, the agent will: push the page to Framer as a draft, request review by the assigned editor, ' +
    'and queue a follow-up cron run to verify indexing in 48h.',
  previewUrl: 'https://workspace.example/preview/cluster-1',
  requestedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),  // 2 days pending
};

const approvalResolved: ApprovalResolution = {
  tenantName: 'Tarino',
  summary: 'Publish cluster page #1 to /resources/how-to-hire-offshore-australia',
  resolution: 'approved',
  resolvedBy: '<@U054RAAHUL>',
  resolvedAt: NOW,
  comment: 'Looks good. Push to draft and tag Chris for editorial review.',
};

// ── Daily run report ────────────────────────────────────────────────

const dailyRun: DailyRunReport = {
  tenantName: 'Tarino',
  tenantSlug: 'tarino',
  runId: RUN_ID,
  runDate: NOW,
  trigger: 'cron',
  shippedActions: [
    {
      id: 'a1',
      title: 'FAQPage schema added to homepage',
      detail: '11 Q&A pairs from /#faq mapped into JSON-LD · pushed via Framer MCP',
      executedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000 - 48 * 60_000),
      status: 'success',
    },
    {
      id: 'a2',
      title: 'Meta descriptions rewritten on /about and /contact-page',
      detail: 'Both were truncating mid-sentence in SERP · old + new diff logged',
      executedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000 - 31 * 60_000),
      status: 'success',
    },
    {
      id: 'a3',
      title: 'Internal link inserted /#how-we-hire → /resources hub',
      detail: 'Anchor text "structured offshore hiring process" · closes orphan path',
      executedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000 - 24 * 60_000),
      status: 'success',
    },
    {
      id: 'a4',
      title: 'Cluster brief drafted: "Hiring offshore paraplanners in Australia"',
      detail: '3rd of 12 briefs supporting the offshore-hiring-AU pillar · 1,847 words, intent + headers + linking plan',
      executedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000 - 1 * 60_000),
      status: 'success',
    },
    {
      id: 'a5',
      title: 'Reddit answer drafted on r/AusFinance "Has anyone hired offshore staff?"',
      detail: 'AEO citation play · queued for human review before posting',
      executedAt: new Date(NOW.getTime() - 5 * 60 * 60 * 1000 - 36 * 60_000),
      status: 'success',
    },
  ],
  newOpportunities: [
    {
      id: 'o1',
      description: '/pricing has highest commercial intent but no schema · est. 12% CTR lift if Product/Offer marked up',
      priority: 'P1',
    },
    {
      id: 'o2',
      description: '"offshore accountant Australia" · ranking #14, low-DR competitor at #3 · cluster gap closable in 2 briefs',
      priority: 'P1',
    },
    {
      id: 'o3',
      description: 'Competitor (Hammerjack) added 3 new pillar pages last week · topic gap widening',
      priority: 'P2',
    },
  ],
  queuedForToday: [
    { id: 'q1', title: 'Cluster brief #4 — "Offshore bookkeeper Australia"',          estimateMinutes: 25 },
    { id: 'q2', title: 'Schema audit on /pricing & /about (Product, Service, Offer)', estimateMinutes: 10 },
    { id: 'q3', title: 'GSC delta check · rank movement on 14 priority keywords',     estimateMinutes: 5 },
  ],
  awaitingApproval: [
    {
      id: 'p1',
      title: 'Publish cluster page #1 to /resources/how-to-hire-offshore-australia',
      detail: 'Live publish · review draft → approve in Sheets',
      pendingSince: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
      approvalUrl: 'https://workspace.example/approvals/apr_h2pb0xq3',
    },
    {
      id: 'p2',
      title: 'Post Reddit answer on r/AusFinance',
      detail: 'Brand-mention play · review tone → approve in Sheets',
      pendingSince: new Date(NOW.getTime() - 30_000),
      approvalUrl: 'https://workspace.example/approvals/apr_zk2fpq91',
    },
  ],
  nextRunAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  workspaceUrl: 'https://workspace.example/tarino',
};

const dailyRunEmpty: DailyRunReport = {
  ...dailyRun,
  shippedActions: [],
  newOpportunities: [],
  queuedForToday: [],
  awaitingApproval: [],
};

// ── Weekly audit ────────────────────────────────────────────────────

const weeklyAudit: WeeklyAuditReport = {
  tenantName: 'Tarino',
  tenantSlug: 'tarino',
  weekStart: new Date('2026-05-12T08:00:00+10:00'),
  trigger: 'cron',
  summary: {
    actionsShipped: 23,
    clusterBriefsLanded: 4,
    rankingsImproved: 2,
    riskFlags: 1,
  },
  stateOfPlay: [
    { label: 'Indexed pages',       value: '14',   delta: '+3 vs last wk',  deltaDirection: 'up' },
    { label: 'Ranking keywords',    value: '28',   delta: '+6 vs last wk',  deltaDirection: 'up' },
    { label: 'Schema coverage',     value: '71%',  delta: '+42pt',          deltaDirection: 'up' },
    { label: 'Avg position',        value: '38.2', delta: '−2.1',           deltaDirection: 'up' },
    { label: 'AI citations (est.)', value: '4',    delta: '+2',             deltaDirection: 'up' },
    { label: 'Domain rating',       value: '3',    delta: 'unchanged',      deltaDirection: 'flat' },
  ],
  topPriorities: [
    {
      rank: 'P0',
      title: 'Publish cluster page #1',
      detail: 'Topical authority compounds once 3+ cluster pages land · current bottleneck',
      impact: 'high',
    },
    {
      rank: 'P0',
      title: 'Schema on /pricing',
      detail: 'Product + Offer schema · estimated 12% CTR lift on commercial-intent SERPs',
      impact: 'high',
    },
    {
      rank: 'P1',
      title: 'Reddit + LinkedIn AEO push',
      detail: '4 drafted answers awaiting approval · top 3 LLM citation sources',
      impact: 'med',
    },
  ],
  clusterProgress: [
    {
      pillarTopic: 'Pillar #1 — Hire offshore in Australia',
      state: 'in_progress',
      briefsTotal: 12,
      briefsLanded: 3,
      awaitingPublish: 1,
      detail: 'Pillar drafted · 3 of 12 cluster briefs landed · 1 awaiting publish · projected complete in 5 weeks',
    },
    {
      pillarTopic: 'Pillar #2 — Managing offshore teams (planned)',
      state: 'planned',
      briefsTotal: 0,
      briefsLanded: 0,
      awaitingPublish: 0,
      detail: 'Discovery starts week of 19 May once #1 momentum is built',
    },
  ],
  riskFlags: [
    {
      title: 'Hammerjack (competitor) added 3 pillar pages this week',
      detail: 'Topic gap on "offshore accounting AU" widening · increase cluster cadence to stay ahead',
      severity: 'monitor',
    },
  ],
  approvalQueueCount: 2,
  nextAuditAt: new Date('2026-05-19T08:00:00+10:00'),
  workspaceUrl: 'https://workspace.example/tarino',
};

// ── Run all renders ─────────────────────────────────────────────────

interface NamedRender {
  name: string;
  message: RenderedMessage;
}

const cases: NamedRender[] = [
  { name: 'anchor / running',                  message: renderAnchor(anchorRunning) },
  { name: 'anchor / awaiting approval',        message: renderAnchor(anchorAwaitingApproval) },
  { name: 'anchor / complete',                 message: renderAnchor(anchorComplete) },
  { name: 'thread / specialist done',          message: renderSpecialistThread(specialistReply) },
  { name: 'thread / final report',             message: renderFinalReportThread(finalReport) },
  { name: 'approval / requested',              message: renderApprovalRequest(approvalReq) },
  { name: 'approval / resolved',               message: renderApprovalResolved(approvalResolved) },
  { name: 'daily / typical',                   message: renderDailyRun(dailyRun) },
  { name: 'daily / empty (first run)',         message: renderDailyRun(dailyRunEmpty) },
  { name: 'weekly / typical audit',            message: renderWeeklyAudit(weeklyAudit) },
];

let failCount = 0;
for (const c of cases) {
  const banner = `── ${c.name} ` + '─'.repeat(Math.max(0, 60 - c.name.length));
  process.stdout.write(`\n${banner}\n`);
  process.stdout.write(`fallback text: ${JSON.stringify(c.message.text)}\n`);
  process.stdout.write(`block count:   ${c.message.blocks.length}\n`);

  if (c.message.blocks.length === 0) {
    process.stdout.write(`  ✗ FAIL — no blocks rendered\n`);
    failCount++;
    continue;
  }
  if (c.message.blocks.length > 50) {
    process.stdout.write(`  ✗ FAIL — exceeds Slack's 50 block limit\n`);
    failCount++;
    continue;
  }
  if (!c.message.text) {
    process.stdout.write(`  ✗ FAIL — empty fallback text\n`);
    failCount++;
    continue;
  }

  process.stdout.write(`${JSON.stringify(c.message.blocks, null, 2)}\n`);
  process.stdout.write(`  ✓ rendered ${c.message.blocks.length} blocks\n`);
}

const summary = failCount === 0
  ? `\n✓ All ${cases.length} renders passed.\n`
  : `\n✗ ${failCount} of ${cases.length} renders failed.\n`;

process.stdout.write(summary);
process.exit(failCount === 0 ? 0 : 1);
