// scripts/smoke-slack-render.ts
//
// Run with: npx tsx scripts/smoke-slack-render.ts
//
// Pure render smoke test — exercises every state in the SlackPresenter
// rendering pipeline and prints the output so a human can eyeball it before
// shipping. No DB, no Slack, no network. Safe to run anywhere with the repo
// installed.

import {
  renderAnchor, renderSpecialistComplete, renderSpecialistFailed,
  renderFinalReport, renderApprovalRequest, renderApprovalResolved,
  renderBudgetWarning,
} from '../src/core/slack/render'
import type { RunState, SpecialistEntry } from '../src/core/slack/types'

const baseTime = Date.now() - 2 * 60 * 1000  // run started 2 min ago

const baseState: RunState = {
  taskId:     'task-abc-123',
  tenantId:   'acme-corp',
  agentType:  'seo-auditor',
  clientName: 'Acme Corp',
  prompt:     'Run a full audit on acme.com including technical, content, and competitor analysis.',
  channelId:  'C1234567',
  startedAt:  baseTime,
  phase:      'starting',
  revision:   0,
  specialists: {},
}

function header(label: string) {
  console.log('')
  console.log('═'.repeat(70))
  console.log(label)
  console.log('═'.repeat(70))
}

// ── Anchor: starting (just the prompt + status, no specialists yet)
header('1. Anchor — phase: starting')
console.log(renderAnchor(baseState))

// ── Anchor: planning with two specialists queued
header('2. Anchor — phase: planning, two queued')
console.log(renderAnchor({
  ...baseState,
  phase: 'planning',
  planSummary: 'Spawning 4 specialists: technical audit, keyword research, content audit, competitors.',
  specialists: {
    'technical-auditor': {
      type: 'technical-auditor', name: 'Technical SEO Auditor', scopedTask: 'Crawl and check technical factors',
      state: { status: 'queued', spawnedAt: baseTime + 30_000 },
    },
    'keyword-researcher': {
      type: 'keyword-researcher', name: 'Keyword Researcher', scopedTask: 'GSC analysis + quick wins',
      state: { status: 'queued', spawnedAt: baseTime + 31_000 },
    },
  },
}))

// ── Anchor: running (mix of running, complete, queued)
header('3. Anchor — phase: running, mixed states')
console.log(renderAnchor({
  ...baseState,
  phase: 'running',
  planSummary: 'Spawning 4 specialists: technical audit, keyword research, content audit, competitors.',
  specialists: {
    'technical-auditor': {
      type: 'technical-auditor', name: 'Technical SEO Auditor', scopedTask: 'Crawl and check technical factors',
      state: { status: 'complete', startedAt: baseTime + 30_000, completedAt: baseTime + 90_000,
        summary: 'Found 14 issues — 3 critical (broken canonicals on /blog/*), 6 high, 5 medium.', tokenCount: 18420 },
    },
    'keyword-researcher': {
      type: 'keyword-researcher', name: 'Keyword Researcher', scopedTask: 'GSC analysis + quick wins',
      state: { status: 'running', startedAt: baseTime + 31_000, lastNote: 'Querying Search Console for last 90 days' },
    },
    'content-auditor': {
      type: 'content-auditor', name: 'Content Auditor', scopedTask: 'Score content quality',
      state: { status: 'queued', spawnedAt: baseTime + 32_000 },
    },
    'competitor-analyst': {
      type: 'competitor-analyst', name: 'Competitor Analyst', scopedTask: 'Compare to top 3',
      state: { status: 'failed', startedAt: baseTime + 33_000, failedAt: baseTime + 60_000,
        error: 'Ahrefs API rate limit hit — retry after 5min' },
    },
  },
}))

// ── Anchor: synthesising
header('4. Anchor — phase: synthesising')
console.log(renderAnchor({
  ...baseState,
  phase: 'synthesising',
  planSummary: 'Spawning 4 specialists.',
  specialists: {
    'technical-auditor': {
      type: 'technical-auditor', name: 'Technical SEO Auditor', scopedTask: 'x',
      state: { status: 'complete', startedAt: baseTime + 30_000, completedAt: baseTime + 90_000,
        summary: 'Found 14 issues', tokenCount: 18420 },
    },
    'keyword-researcher': {
      type: 'keyword-researcher', name: 'Keyword Researcher', scopedTask: 'x',
      state: { status: 'complete', startedAt: baseTime + 31_000, completedAt: baseTime + 95_000,
        summary: '23 quick-win keywords identified', tokenCount: 12100 },
    },
  },
}))

// ── Anchor: complete
header('5. Anchor — phase: complete')
console.log(renderAnchor({
  ...baseState,
  phase: 'complete',
  planSummary: 'Spawning 2 specialists.',
  specialists: {
    'technical-auditor': {
      type: 'technical-auditor', name: 'Technical SEO Auditor', scopedTask: 'x',
      state: { status: 'complete', startedAt: baseTime + 30_000, completedAt: baseTime + 90_000,
        summary: 'Found 14 issues', tokenCount: 18420 },
    },
    'keyword-researcher': {
      type: 'keyword-researcher', name: 'Keyword Researcher', scopedTask: 'x',
      state: { status: 'complete', startedAt: baseTime + 31_000, completedAt: baseTime + 95_000,
        summary: '23 quick-win keywords identified', tokenCount: 12100 },
    },
  },
  finalReport: { summaryText: '...', fullLength: 4200 },
}))

// ── Anchor: failed
header('6. Anchor — phase: failed')
console.log(renderAnchor({
  ...baseState,
  phase: 'failed',
  errorSummary: 'Aggregator threw: cannot synthesise — every specialist failed.',
  specialists: {
    'technical-auditor': {
      type: 'technical-auditor', name: 'Technical SEO Auditor', scopedTask: 'x',
      state: { status: 'failed', startedAt: baseTime + 30_000, failedAt: baseTime + 60_000,
        error: 'fetch ETIMEDOUT acme.com' },
    },
  },
}))

// ── Thread: specialist complete
header('7. Thread — specialist complete')
const completeEntry: SpecialistEntry = {
  type: 'technical-auditor', name: 'Technical SEO Auditor', scopedTask: 'x',
  state: { status: 'complete', startedAt: baseTime + 30_000, completedAt: baseTime + 90_000,
    summary: 'Found 14 issues across 247 crawled pages.\n\n- 3 critical: broken canonicals\n- 6 high: missing alt text\n- 5 medium: thin content',
    tokenCount: 18420 },
}
console.log(renderSpecialistComplete(completeEntry))

// ── Thread: specialist failed
header('8. Thread — specialist failed')
const failedEntry: SpecialistEntry = {
  type: 'competitor-analyst', name: 'Competitor Analyst', scopedTask: 'x',
  state: { status: 'failed', startedAt: baseTime + 33_000, failedAt: baseTime + 60_000,
    error: 'Ahrefs API rate limit — exhausted today\'s quota' },
}
console.log(renderSpecialistFailed(failedEntry))

// ── Thread: final report (short)
header('9. Thread — final report (short)')
console.log(renderFinalReport(
  '## Executive summary\nAcme.com has solid technical fundamentals but content opportunities.\n\n## P1 findings\n- Broken canonicals on /blog/*\n- 23 quick-win keyword targets',
  'Acme Corp',
))

// ── Thread: final report (truncated)
header('10. Thread — final report (truncated, simulated long)')
console.log(renderFinalReport('A'.repeat(5000), 'Acme Corp'))

// ── Approval messages
header('11. Channel — approval request')
console.log(renderApprovalRequest({
  tenantId: 'acme-corp', channelId: 'C123', taskId: 'task-abc-123',
  toolName: 'cms_publish', riskLevel: 'high',
  riskReason: 'Publishing to live CMS modifies production content',
  approvalId: 'appr-789',
}))

header('12. Channel — approval approved')
console.log(renderApprovalResolved({
  tenantId: 'acme-corp', channelId: 'C123', taskId: 'task-abc-123',
  toolName: 'cms_publish', approvalId: 'appr-789', decision: 'approved',
  resolvedBy: 'sarah@acme.com',
}))

header('13. Channel — approval rejected')
console.log(renderApprovalResolved({
  tenantId: 'acme-corp', channelId: 'C123', taskId: 'task-abc-123',
  toolName: 'cms_publish', approvalId: 'appr-789', decision: 'rejected',
  resolvedBy: 'sarah@acme.com',
  rejectionReason: 'Want to review the draft first — please send the diff before publishing',
}))

header('14. Channel — approval timeout')
console.log(renderApprovalResolved({
  tenantId: 'acme-corp', channelId: 'C123', taskId: 'task-abc-123',
  toolName: 'cms_publish', approvalId: 'appr-789', decision: 'timeout',
}))

// ── Budget warning
header('15. Channel — budget warning')
console.log(renderBudgetWarning({
  tenantId: 'acme-corp', channelId: 'C123', taskId: 'task-abc-123',
  clientName: 'Acme Corp', spent: 102_500, cap: 100_000,
}))

console.log('')
console.log('═'.repeat(70))
console.log('Smoke test complete. Eyeball the output above for any visual issues.')
console.log('═'.repeat(70))
