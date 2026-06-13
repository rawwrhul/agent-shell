// src/core/slack/blocks/daily-run.ts
//
// Daily run report. Renders inline in the anchor message when phase
// transitions to 'complete' on a cron-triggered (or on-demand) daily run.
//
// R3 changes:
//   - Added TL;DR section at the top (3-5 outcome-focused bullets)
//   - Awaiting-approval items now render with inline action buttons
//     (View draft / Approve / Reject / Defer 24h / Open in Sheets)
//     instead of just a `Review →` link
//
// Structure:
//   Header + summary line
//   ── TL;DR (R3 NEW)
//   ── Shipped overnight
//   ── New opportunities surfaced
//   ── Queued for today
//   ── Awaiting your approval (with inline buttons)
//   ── Footer

import type { KnownBlock } from '@slack/web-api';
import {
  header,
  section,
  context,
  divider,
  titledSection,
  itemList,
  actions,
  fallbackText,
  formatTime,
  formatDate,
  formatRelative,
  compact,
  capBlocks,
  type ListItem,
  type ButtonSpec,
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
    report.performancePulse && context([`📊 ${report.performancePulse}`]),
    section(summary),

    // ── TL;DR (R3 NEW) ────────────────────────────────────────────
    report.tldr.length > 0 && divider(),
    report.tldr.length > 0 && titledSection(
      'TL;DR',
      report.tldr.map((t) => `•  ${t}`).join('\n')
    ),

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

    // ── Awaiting approval (R3: inline action buttons) ─────────────
    report.awaitingApproval.length > 0 && divider(),
    report.awaitingApproval.length > 0 && titledSection(
      '🔔 Awaiting your call',
      awaitingSummaryLine(report.awaitingApproval)
    ),
    ...renderApprovalItemsWithActions(report.awaitingApproval),

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
    (min: Date, i) => {
      // Coerce — pendingSince may arrive as a JSON string, not a Date
      const d = i.pendingSince instanceof Date ? i.pendingSince : new Date(i.pendingSince as any)
      return Number.isNaN(d.getTime()) ? min : (d < min ? d : min)
    },
    new Date()
  );
  return `${items.length} blocked · oldest pending ${formatRelative(oldest)}`;
}

// ── Item builders ───────────────────────────────────────────────────

function shippedToItem(a: ShippedAction): ListItem {
  return {
    icon: a.status === 'success' ? '🟢' : '🟡',
    title: a.title,
    detail: a.detail,
    meta: formatTime(a.executedAt),
  };
}

function opportunityToItem(o: Opportunity): ListItem {
  return {
    icon: '🔸',
    title: o.description,
    meta: o.priority,
  };
}

function queuedToItem(q: QueuedAction): ListItem {
  return {
    icon: '○',
    title: q.title,
    meta: q.estimateMinutes ? `~${q.estimateMinutes} min` : undefined,
  };
}

// ── R3: Approval items with inline action buttons ───────────────────

function renderApprovalItemsWithActions(items: ApprovalItem[]): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  for (const item of items) {
    const dot = severityDot(item.severity);
    const pendingLabel = `_pending ${formatRelative(item.pendingSince)}_`;
    blocks.push(section(
      `${dot}  *${item.title}*\n` +
      (item.detail ? `${item.detail}\n` : '') +
      pendingLabel
    ));
    blocks.push(buildApprovalActions(item));
  }
  return blocks;
}

function severityDot(severity?: ApprovalItem['severity']): string {
  switch (severity) {
    case 'critical': return '🔴';
    case 'high':     return '🟠';
    case 'medium':   return '🟡';
    case 'low':      return '⚪';
    default:         return '🟡';
  }
}

function buildApprovalActions(item: ApprovalItem): KnownBlock {
  const buttons: ButtonSpec[] = [
    { actionId: 'approval_view_draft', text: 'View draft', value: item.id },
    { actionId: 'approval_approve',    text: 'Approve',    value: item.id, style: 'primary' },
    { actionId: 'approval_reject',     text: 'Reject',     value: item.id, style: 'danger' },
    { actionId: 'approval_defer',      text: 'Defer 24h',  value: item.id },
  ];
  return actions(`approval_${item.id}`, buttons);
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

function formatNextRunLabel(d: Date | string): string {
  d = d instanceof Date ? d : new Date(d)
  const now = new Date();
  const diffHr = (d.getTime() - now.getTime()) / 3_600_000;

  if (diffHr < 18) {
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
