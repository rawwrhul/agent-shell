// src/core/slack/blocks/daily-run.ts
//
// Daily run report. Posted as a channel message (not threaded) at the end
// of every cron-triggered or on-demand run.
//
// Structure mirrors the design mock:
//   Header + summary line
//   ── Shipped overnight (executed actions w/ outcomes)
//   ── New opportunities surfaced
//   ── Queued for today
//   ── Awaiting your approval (HITL)
//   ── Footer (next run, on-demand command, workspace link)

import type { KnownBlock } from '@slack/web-api';
import {
  header,
  section,
  context,
  divider,
  titledSection,
  itemList,
  fallbackText,
  formatTime,
  formatDate,
  formatRelative,
  compact,
  capBlocks,
  type ListItem,
} from './shared';
import type {
  RenderedMessage,
  DailyRunReport,
  ShippedAction,
  Opportunity,
  QueuedAction,
  ApprovalItem,
} from './types';

export function renderDailyRun(report: DailyRunReport): RenderedMessage {
  const headline = buildHeadline(report);
  const summary = buildSummary(report);

  const triggerNote = report.trigger === 'on_demand'
    ? '_Triggered on-demand_'
    : '_Daily cron run_';

  const blocks = compact<KnownBlock>([
    header(headline),
    context([triggerNote, formatDate(report.runDate)]),
    section(summary),

    // ── Shipped overnight ─────────────────────────────────────────
    report.shippedActions.length > 0 && divider(),
    report.shippedActions.length > 0 && titledSection(
      'Shipped overnight',
      shippedSummaryLine(report.shippedActions)
    ),
    report.shippedActions.length > 0 && itemList(
      report.shippedActions.map(shippedToItem)
    ),

    // ── New opportunities surfaced ────────────────────────────────
    report.newOpportunities.length > 0 && divider(),
    report.newOpportunities.length > 0 && titledSection(
      'New opportunities surfaced',
      `${report.newOpportunities.length} ${report.newOpportunities.length === 1 ? 'opportunity' : 'opportunities'} detected this run`
    ),
    report.newOpportunities.length > 0 && itemList(
      report.newOpportunities.map(opportunityToItem)
    ),

    // ── Queued for today ──────────────────────────────────────────
    report.queuedForToday.length > 0 && divider(),
    report.queuedForToday.length > 0 && titledSection(
      'Queued for today',
      queuedSummaryLine(report.queuedForToday)
    ),
    report.queuedForToday.length > 0 && itemList(
      report.queuedForToday.map(queuedToItem)
    ),

    // ── Awaiting approval (HITL) ─────────────────────────────────
    report.awaitingApproval.length > 0 && divider(),
    report.awaitingApproval.length > 0 && titledSection(
      'Awaiting your approval',
      awaitingSummaryLine(report.awaitingApproval)
    ),
    report.awaitingApproval.length > 0 && itemList(
      report.awaitingApproval.map(approvalToItem)
    ),

    // ── Empty-state ──────────────────────────────────────────────
    isEmpty(report) && divider(),
    isEmpty(report) && section(
      ':sparkles: _No actions, opportunities, or queued work this run. Likely first run on this tenant — agent is bootstrapping._'
    ),

    // ── Footer ───────────────────────────────────────────────────
    divider(),
    context(buildFooterParts(report)),
  ]);

  return {
    text: fallbackText({ title: headline, summary }),
    blocks: capBlocks(blocks),
  };
}

// ── Summary builders ────────────────────────────────────────────────

function buildHeadline(report: DailyRunReport): string {
  return `🔄  ${report.tenantName} · Daily run`;
}

function buildSummary(report: DailyRunReport): string {
  const parts: string[] = [];
  const shipped = report.shippedActions.length;
  const queued = report.queuedForToday.length;
  const awaiting = report.awaitingApproval.length;

  if (shipped > 0) {
    parts.push(`*${shipped}* action${shipped === 1 ? '' : 's'} shipped since last run`);
  } else {
    parts.push('No actions shipped since last run');
  }
  if (queued > 0) {
    parts.push(`*${queued}* queued for today`);
  }
  if (awaiting > 0) {
    parts.push(`*${awaiting}* awaiting your approval`);
  }
  return parts.join(' · ');
}

function shippedSummaryLine(actions: ShippedAction[]): string {
  const failures = actions.filter((a) => a.status === 'partial').length;
  if (failures === 0) {
    return `${actions.length} action${actions.length === 1 ? '' : 's'} executed cleanly`;
  }
  return `${actions.length} actions, ${failures} partial`;
}

function queuedSummaryLine(items: QueuedAction[]): string {
  const totalMin = items.reduce((sum, q) => sum + (q.estimateMinutes ?? 0), 0);
  if (totalMin === 0) return `${items.length} item${items.length === 1 ? '' : 's'} in queue`;
  return `${items.length} items · ~${totalMin} min total`;
}

function awaitingSummaryLine(items: ApprovalItem[]): string {
  const oldest = items.reduce(
    (max, i) => (i.pendingSince < max ? i.pendingSince : max),
    new Date()
  );
  return `${items.length} blocked · oldest pending ${formatRelative(oldest)}`;
}

// ── Item builders ───────────────────────────────────────────────────

function shippedToItem(a: ShippedAction): ListItem {
  return {
    icon: a.status === 'success' ? ':large_green_circle:' : ':large_orange_circle:',
    title: a.title,
    detail: a.detail,
    meta: formatTime(a.executedAt),
  };
}

function opportunityToItem(o: Opportunity): ListItem {
  return {
    icon: ':small_orange_diamond:',
    title: o.description,
    meta: o.priority,
  };
}

function queuedToItem(q: QueuedAction): ListItem {
  return {
    icon: ':white_circle:',
    title: q.title,
    meta: q.estimateMinutes ? `~${q.estimateMinutes} min` : undefined,
  };
}

function approvalToItem(a: ApprovalItem): ListItem {
  const detail = a.approvalUrl
    ? `${a.detail ?? ''}${a.detail ? ' · ' : ''}<${a.approvalUrl}|Review →>`
    : a.detail;
  return {
    icon: ':red_circle:',
    title: a.title,
    detail,
    meta: formatRelative(a.pendingSince),
  };
}

// ── Footer ──────────────────────────────────────────────────────────

function buildFooterParts(report: DailyRunReport): string[] {
  const parts: string[] = [];

  if (report.nextRunAt) {
    parts.push(`Next cron: *${formatNextRunLabel(report.nextRunAt)}*`);
  }
  parts.push(`Trigger another now: \`/${report.tenantSlug} run\``);
  if (report.workspaceUrl) {
    parts.push(`<${report.workspaceUrl}|Full work log ↗>`);
  }
  return parts;
}

function formatNextRunLabel(d: Date): string {
  const now = new Date();
  const diffHr = (d.getTime() - now.getTime()) / 3_600_000;

  if (diffHr < 18) {
    // Same / next morning
    return `today ${formatTime(d)}`;
  }
  if (diffHr < 36) {
    return `tomorrow ${formatTime(d)}`;
  }
  return `${formatDate(d)} ${formatTime(d)}`;
}

function isEmpty(report: DailyRunReport): boolean {
  return (
    report.shippedActions.length === 0 &&
    report.newOpportunities.length === 0 &&
    report.queuedForToday.length === 0 &&
    report.awaitingApproval.length === 0
  );
}
