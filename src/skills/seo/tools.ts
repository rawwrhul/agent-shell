// src/skills/seo/tools.ts
//
// Anthropic-format tool definitions for the SEO skill, bound to the actual
// R2-shipped data-store signatures in src/seo/data-store.ts.

import type Anthropic from '@anthropic-ai/sdk';
import { Pool } from 'pg';
import { config } from '../../config';
import {
  logAction,
  recordOpportunity,
  captureSnapshot,
  upsertCluster,
  listOpportunities,
  listClusters,
  listActionsSinceLastRun,
} from '../../seo/data-store';
import type { ActionType } from '../../seo/types';
import { createApproval } from '../../hitl/state-store';

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL });
  return _pool;
}

// ── Tool definitions ───────────────────────────────────────────────

export const SEO_TOOLS: Anthropic.Tool[] = [
  {
    name: 'log_seo_action',
    description:
      "Record a concrete action that was JUST TAKEN (or just confirmed shipped). " +
      "Use after every action that shipped — schema additions, meta updates, content publishes, " +
      "internal links, technical fixes. Populates the 'Shipped overnight' section of daily reports.",
    input_schema: {
      type: 'object' as const,
      properties: {
        actionType: {
          type: 'string',
          description: 'Type of work (must match ActionType enum in seo/types).',
        },
        targetUrl: {
          type: 'string',
          description: 'URL or page path the action targeted.',
        },
        summary: {
          type: 'string',
          description: '1-line outcome-focused summary that will appear in reports verbatim. Lead with verb.',
        },
        detail: {
          type: 'string',
          description: 'Optional longer-form context.',
        },
        status: {
          type: 'string',
          enum: ['success', 'partial', 'failed', 'awaiting_approval', 'queued'],
          description: "Action status. Default 'success'.",
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata.',
        },
      },
      required: ['actionType', 'summary'],
    },
  },
  {
    name: 'log_opportunity',
    description:
      "Record an opportunity FOUND. Populates the 'New opportunities surfaced' section of daily reports.",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Opportunity type.' },
        target: { type: 'string', description: 'URL, page path, or element this concerns.' },
        description: { type: 'string' },
        rationale: { type: 'string' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
        estimatedImpact: { type: 'string' },
      },
      required: ['type', 'description', 'priority'],
    },
  },
  {
    name: 'snapshot_metrics',
    description: "Record a point-in-time metrics snapshot. Run once per daily/weekly cycle.",
    input_schema: {
      type: 'object' as const,
      properties: {
        indexedPages:           { type: 'number' },
        rankingKeywords:        { type: 'number' },
        schemaCoveragePct:      { type: 'number' },
        avgPosition:            { type: 'number' },
        aiCitationsEstimated:   { type: 'number' },
        domainRating:           { type: 'number' },
        rawSources:             { type: 'object' },
      },
      required: [],
    },
  },
  {
    name: 'upsert_cluster',
    description: "Define or update a topical cluster.",
    input_schema: {
      type: 'object' as const,
      properties: {
        pillarTopic:      { type: 'string' },
        pillarUrl:        { type: 'string' },
        state: { type: 'string', enum: ['planned', 'in_progress', 'complete', 'paused'] },
        briefsTotal:      { type: 'number' },
        briefsDrafted:    { type: 'number' },
        briefsPublished:  { type: 'number' },
        awaitingPublish:  { type: 'number' },
        detail:           { type: 'string' },
      },
      required: ['pillarTopic', 'state'],
    },
  },
  {
    name: 'query_opportunities',
    description: "Read existing opportunities. Use BEFORE creating new ones to avoid duplicates.",
    input_schema: {
      type: 'object' as const,
      properties: {
        status:   { type: 'string' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
      },
      required: [],
    },
  },
  {
    name: 'query_clusters',
    description: "Read all clusters for this tenant.",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'query_recent_actions',
    description: "Read actions logged since the previous run completed.",
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'propose_action',
    description:
      "Create a HITL approval request for any action that touches the public site or sends external " +
      "messages. DOES NOT execute — only files the request.",
    input_schema: {
      type: 'object' as const,
      properties: {
        toolName:       { type: 'string' },
        toolInput:      { type: 'object' },
        proposedAction: { type: 'string' },
        detail:         { type: 'array', items: { type: 'string' } },
        whyPriority:    { type: 'string' },
        priority:       { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        riskLevel:      { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['toolName', 'toolInput', 'proposedAction', 'priority'],
    },
  },
];

// ── Dispatch ────────────────────────────────────────────────────────

const SEO_TOOL_NAMES = new Set(SEO_TOOLS.map((t) => t.name));

export function isSeoToolName(name: string): boolean {
  return SEO_TOOL_NAMES.has(name);
}

export interface SeoToolContext {
  tenantId: string;
  runId:    string;
  taskId:   string;
}

export async function executeSeoTool(
  name: string,
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'log_seo_action':       return await doLogAction(input, ctx);
      case 'log_opportunity':      return await doLogOpportunity(input, ctx);
      case 'snapshot_metrics':     return await doSnapshotMetrics(input, ctx);
      case 'upsert_cluster':       return await doUpsertCluster(input, ctx);
      case 'query_opportunities':  return await doQueryOpportunities(input, ctx);
      case 'query_clusters':       return await doQueryClusters(ctx);
      case 'query_recent_actions': return await doQueryRecentActions(ctx);
      case 'propose_action':       return await doProposeAction(input, ctx);
      default:                     return `Unknown SEO tool: ${name}`;
    }
  } catch (err) {
    return `SEO tool error: ${String(err)}`;
  }
}

// ── Tool implementations ───────────────────────────────────────────

async function doLogAction(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {
  const i = input as {
    actionType: string;
    targetUrl?: string;
    summary: string;
    detail?: string;
    status?: 'success' | 'partial' | 'failed' | 'awaiting_approval' | 'queued';
    metadata?: Record<string, unknown>;
  };
  // Cast string → ActionType — the model's tool schema enforces valid values
  // at the API layer; this cast just satisfies TS.
  const row = await logAction(pool(), {
    tenantId:   ctx.tenantId,
    runId:      ctx.runId,
    actionType: i.actionType as ActionType,
    targetUrl:  i.targetUrl,
    summary:    i.summary,
    detail:     i.detail,
    status:     i.status,
    metadata:   i.metadata,
  });
  return `Action logged: ${row.summary} (${row.status})`;
}

async function doLogOpportunity(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {
  const i = input as {
    type: string;
    target?: string;
    description: string;
    rationale?: string;
    priority: 'P0' | 'P1' | 'P2';
    estimatedImpact?: string;
  };
  await recordOpportunity(pool(), {
    tenantId:    ctx.tenantId,
    runId:       ctx.runId,
    type:        i.type as Parameters<typeof recordOpportunity>[1]['type'],
    target:      i.target,
    description: i.description,
    rationale:   i.rationale,
    priority:    i.priority,
    estimatedImpact: i.estimatedImpact,
  });
  return `Opportunity recorded: [${i.priority}] ${i.description}`;
}

async function doSnapshotMetrics(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {
  const i = input as Record<string, number | object | undefined>;
  await captureSnapshot(pool(), {
    tenantId:              ctx.tenantId,
    indexedPages:          asNum(i.indexedPages),
    rankingKeywords:       asNum(i.rankingKeywords),
    schemaCoveragePct:     asNum(i.schemaCoveragePct),
    avgPosition:           asNum(i.avgPosition),
    aiCitationsEstimated:  asNum(i.aiCitationsEstimated),
    domainRating:          asNum(i.domainRating),
    rawSources:            (i.rawSources as Record<string, unknown>) ?? {},
  });
  return `Metrics snapshot recorded.`;
}

async function doUpsertCluster(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {
  const i = input as {
    pillarTopic: string;
    pillarUrl?: string;
    state: 'planned' | 'in_progress' | 'complete' | 'paused';
    briefsTotal?: number;
    briefsDrafted?: number;
    briefsPublished?: number;
    awaitingPublish?: number;
    detail?: string;
  };
  await upsertCluster(pool(), {
    tenantId:         ctx.tenantId,
    pillarTopic:      i.pillarTopic,
    pillarUrl:        i.pillarUrl,
    state:            i.state,
    briefsTotal:      i.briefsTotal      ?? 0,
    briefsDrafted:    i.briefsDrafted    ?? 0,
    briefsPublished:  i.briefsPublished  ?? 0,
    awaitingPublish:  i.awaitingPublish  ?? 0,
    detail:           i.detail,
  });
  return `Cluster ${i.pillarTopic} upserted (state: ${i.state}).`;
}

async function doQueryOpportunities(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {
  const i = input as { status?: string; priority?: 'P0' | 'P1' | 'P2' };
  const rows = await listOpportunities(pool(), {
    tenantId: ctx.tenantId,
    status:   i.status as Parameters<typeof listOpportunities>[1]['status'],
    priority: i.priority,
  });
  if (rows.length === 0) return 'No opportunities found.';
  return rows.slice(0, 30).map((r) =>
    `[${r.priority}/${r.status}] ${r.description}${r.target ? ` — ${r.target}` : ''}`
  ).join('\n');
}

async function doQueryClusters(ctx: SeoToolContext): Promise<string> {
  // listClusters takes (db, tenantId: string), not an object
  const rows = await listClusters(pool(), ctx.tenantId);
  if (rows.length === 0) return 'No clusters defined yet.';
  return rows.map((r) =>
    `[${r.state}] ${r.pillarTopic} — ${r.briefsPublished ?? 0}/${r.briefsTotal ?? '?'} briefs`
  ).join('\n');
}

async function doQueryRecentActions(ctx: SeoToolContext): Promise<string> {
  const rows = await listActionsSinceLastRun(pool(), ctx.tenantId, ctx.runId);
  if (rows.length === 0) return 'No actions since last run.';
  return rows.slice(0, 50).map((r) =>
    `[${r.status}] ${r.summary}${r.targetUrl ? ` (${r.targetUrl})` : ''}`
  ).join('\n');
}

async function doProposeAction(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {
  const i = input as {
    toolName: string;
    toolInput: Record<string, unknown>;
    proposedAction: string;
    detail?: string[];
    whyPriority?: string;
    priority: 'P0' | 'P1' | 'P2' | 'P3';
    riskLevel?: 'low' | 'medium' | 'high';
  };
  const approval = await createApproval(pool(), {
    tenantId:       ctx.tenantId,
    taskId:         ctx.taskId,
    toolName:       i.toolName,
    toolInput:      i.toolInput,
    riskLevel:      i.riskLevel ?? 'medium',
    riskReason:     i.whyPriority ?? `Proposed via SEO skill, priority ${i.priority}.`,
    priority:       i.priority,
    proposedAction: i.proposedAction,
    detail:         i.detail ?? [],
    whyPriority:    i.whyPriority,
  });
  return `Approval ${approval.id.slice(0, 8)} filed (${approval.priority}, risk ${approval.riskLevel}).`;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}
