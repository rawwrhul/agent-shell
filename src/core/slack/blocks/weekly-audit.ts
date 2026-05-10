// src/core/slack/blocks/weekly-audit.ts
//
// Weekly audit report. The strategic, comprehensive view — posted as a
// channel message at the start of the week (Mon 8am cron) or on demand.
//
// Structure:
//   Header + summary
//   ── State of play (scorecard fields)
//   ── Top 3 leverage moves
//   ── Cluster progress
//   ── Risk flags
//   ── Footer (approval queue, next audit, on-demand command)

import type { KnownBlock } from '@slack/web-api';
import {
  header,
  section,
  context,
  divider,
  titledSection,
  fieldsSection,
  itemList,
  priorityList,
  fallbackText,
  formatDate,
  formatTime,
  compact,
  capBlocks,
  type ListItem,
  type PriorityRow,
} from './shared';
import type {
  RenderedMessage,
  WeeklyAuditReport,
  MetricField,
  Priority,
  ClusterStatus,
  RiskFlag,
} from './types';

export function renderWeeklyAudit(report: WeeklyAuditReport): RenderedMessage {
  const headline = `📊  ${report.tenantName} · Weekly audit`;
  const summary = buildAuditSummary(report);

  const triggerNote = report.trigger === 'on_demand'
    ? '_Generated on-demand_'
    : '_Weekly cron audit_';

  const blocks = compact<KnownBlock>([
    header(headline),
    context([triggerNote, `Week of ${formatDate(report.weekStart)}`]),
    section(summary),

    // ── State of play ────────────────────────────────────────────
    report.stateOfPlay.length > 0 && divider(),
    report.stateOfPlay.length > 0 && titledSection(
      'State of play',
      'Snapshot vs. last week'
    ),
    report.stateOfPlay.length > 0 && fieldsSection(
      report.stateOfPlay.map(metricToField)
    ),

    // ── Top priorities ────────────────────────────────────────────
    report.topPriorities.length > 0 && divider(),
    report.topPriorities.length > 0 && titledSection(
      `Next week — top ${report.topPriorities.length} leverage moves`,
      'Ranked by impact × executability'
    ),
    report.topPriorities.length > 0 && priorityList(
      report.topPriorities.map(priorityToRow)
    ),

    // ── Cluster progress ──────────────────────────────────────────
    report.clusterProgress.length > 0 && divider(),
    report.clusterProgress.length > 0 && titledSection(
      'Cluster progress',
      `${report.clusterProgress.length} pillar${report.clusterProgress.length === 1 ? '' : 's'} tracked`
    ),
    report.clusterProgress.length > 0 && itemList(
      report.clusterProgress.map(clusterToItem)
    ),

    // ── Risk flags ────────────────────────────────────────────────
    report.riskFlags.length > 0 && divider(),
    report.riskFlags.length > 0 && titledSection(
      'Risk flags',
      `${report.riskFlags.length} signal${report.riskFlags.length === 1 ? '' : 's'} to monitor`
    ),
    report.riskFlags.length > 0 && itemList(
      report.riskFlags.map(riskToItem)
    ),

    // Empty-state — first audit on a fresh tenant
    isEmpty(report) && divider(),
    isEmpty(report) && section(
      ':sparkles: _Insufficient history for a comparative audit. Agent is in baseline-collection mode — first meaningful audit will land in week 2._'
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

// ── Summary ─────────────────────────────────────────────────────────

function buildAuditSummary(report: WeeklyAuditReport): string {
  const parts: string[] = [];
  const s = report.summary;
  parts.push(`*${s.actionsShipped}* actions shipped this week`);
  if (s.clusterBriefsLanded > 0) {
    parts.push(`*${s.clusterBriefsLanded}* cluster brief${s.clusterBriefsLanded === 1 ? '' : 's'} landed`);
  }
  if (s.rankingsImproved > 0) {
    parts.push(`*${s.rankingsImproved}* ranking${s.rankingsImproved === 1 ? '' : 's'} improved`);
  }
  if (s.riskFlags > 0) {
    parts.push(`*${s.riskFlags}* risk flag${s.riskFlags === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

// ── Field / item builders ───────────────────────────────────────────

function metricToField(m: MetricField): { label: string; value: string } {
  let value = m.value;
  if (m.delta) {
    const arrow =
      m.deltaDirection === 'up'
        ? '↗'
        : m.deltaDirection === 'down'
          ? '↘'
          : '·';
    value = `${m.value}\n_${arrow} ${m.delta}_`;
  }
  return { label: m.label, value };
}

function priorityToRow(p: Priority): PriorityRow {
  return {
    rank: p.rank,
    title: p.title,
    detail: p.detail,
    meta: `impact: ${p.impact}`,
  };
}

function clusterToItem(c: ClusterStatus): ListItem {
  const icon = c.state === 'complete'
    ? ':white_check_mark:'
    : c.state === 'in_progress'
      ? ':large_green_circle:'
      : ':white_circle:';

  const pct = c.briefsTotal > 0
    ? `${Math.round((c.briefsLanded / c.briefsTotal) * 100)}%`
    : '—';

  const detail = buildClusterDetail(c);

  return {
    icon,
    title: c.pillarTopic,
    detail,
    meta: pct,
  };
}

function buildClusterDetail(c: ClusterStatus): string | undefined {
  if (c.detail) return c.detail;
  const parts: string[] = [];
  if (c.briefsTotal > 0) {
    parts.push(`${c.briefsLanded}/${c.briefsTotal} briefs landed`);
  }
  if (c.awaitingPublish > 0) {
    parts.push(`${c.awaitingPublish} awaiting publish`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function riskToItem(r: RiskFlag): ListItem {
  const icon = r.severity === 'urgent'
    ? ':rotating_light:'
    : r.severity === 'act_soon'
      ? ':warning:'
      : ':small_orange_diamond:';

  const meta = r.severity === 'urgent'
    ? 'urgent'
    : r.severity === 'act_soon'
      ? 'act soon'
      : 'monitor';

  return {
    icon,
    title: r.title,
    detail: r.detail,
    meta,
  };
}

// ── Footer ──────────────────────────────────────────────────────────

function buildFooterParts(report: WeeklyAuditReport): string[] {
  const parts: string[] = [];

  if (report.approvalQueueCount > 0) {
    parts.push(
      `Approval queue: *${report.approvalQueueCount} item${report.approvalQueueCount === 1 ? '' : 's'}*`
    );
  } else {
    parts.push('Approval queue: clear');
  }

  if (report.nextAuditAt) {
    parts.push(`Next audit: *${formatNextAuditLabel(report.nextAuditAt)}*`);
  }

  parts.push(`Generate now: \`/${report.tenantSlug} audit\``);

  if (report.workspaceUrl) {
    parts.push(`<${report.workspaceUrl}|Workspace ↗>`);
  }
  return parts;
}

function formatNextAuditLabel(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`;
}

function isEmpty(report: WeeklyAuditReport): boolean {
  return (
    report.stateOfPlay.length === 0 &&
    report.topPriorities.length === 0 &&
    report.clusterProgress.length === 0 &&
    report.riskFlags.length === 0
  );
}
