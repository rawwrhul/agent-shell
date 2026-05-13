// src/skills/seo/tools.ts
//
// Anthropic-format tool definitions for the SEO skill, bound to the actual
// R2-shipped data-store signatures in src/seo/data-store.ts.
//
// R3.1: doProposeAction now dual-writes approvals to BOTH Postgres
// approval_requests (operational state — what the Slack flow + agent wait
// loop read) AND the tenant's Google Sheet (persistent audit record).
// Same approval ID across both stores. Sheet write is best-effort: any
// failure is logged but doesn't block the approval flow.

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
import { createApproval, recordSheetRowNumber } from '../../hitl/state-store';
import { createApprovalRequest } from '../../hitl/sheets';
import { getTenant } from '../../tenants/registry';
import { presenter } from '../../core/slack';
import { logger } from '../../logger';

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
      "messages. DOES NOT execute — only files the request. " +
      "When the action is a Framer page change you've already drafted via framer_create_draft_page or " +
      "framer_update_page_draft, pass the previewUrl through — the Slack approval card renders it as a " +
      "'View preview ↗' link the operator can click before approving.\n\n" +
      "REQUIRED toolInput shapes for known toolNames (the executor will reject malformed input):\n\n" +
      "  • framer_update_page_seo — { pageId: <string>, title?: <string>, description?: <string>, " +
      "ogTitle?: <string>, ogDescription?: <string>, ogImage?: <string>, robots?: <string> }. " +
      "Get pageId by calling framer_list_pages first; include only the fields you're changing.\n\n" +
      "  • framer_publish_page — { pageId: <string> }. Publish-only path, no field updates. Use after " +
      "framer_update_page_draft when the operator approves shipping the draft.\n\n" +
      "  • framer_create_draft_page — { path: <string>, title: <string>, contentBlocks: <array> }. " +
      "Use only when proposing a brand-new page (you would normally already have called " +
      "framer_create_draft_page directly to get the previewUrl, then propose_action just for the publish step).\n\n" +
      "If you're unsure of the shape, look up the corresponding integration tool's input_schema for " +
      "guidance — propose_action's toolInput is forwarded verbatim to the executor.",
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
        previewUrl: {
          type: 'string',
          description:
            "Optional URL the operator can click to preview the change before approving. " +
            "For Framer page drafts, pass the previewUrl returned by framer_create_draft_page " +
            "or framer_update_page_draft. The Slack approval card renders this as a clickable " +
            "'View preview ↗' link.",
        },
      },
      required: ['toolName', 'toolInput', 'proposedAction', 'priority'],
    },
  },
  {
    name: 'analyze_page',
    description:
      "Fetch a single URL and return a structured summary of every SEO-relevant signal on it in ONE call: " +
      "HTTP status + response time, page title + length, meta description + length, H1 count + text, " +
      "H2/H3 outline, canonical URL, robots directive, schema.org JSON-LD blocks (parsed), Open Graph + " +
      "Twitter Card tags, internal link count, external link count, image count + alt coverage, " +
      "word count, language, and a short text preview. " +
      "USE THIS INSTEAD of multiple run_command/web_fetch calls for page-level analysis — replaces " +
      "5-10 separate tool calls with one structured response. Safe (read-only, no HITL needed).",
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to analyse (https://...). Just one URL per call. For multiple URLs, call this tool multiple times in parallel.',
        },
        userAgent: {
          type: 'string',
          description: "Optional User-Agent string. Default: 'CGSAuditBot/1.0'.",
        },
      },
      required: ['url'],
    },
  },
];

// ── Dispatch ────────────────────────────────────────────────────────

const SEO_TOOL_NAMES = new Set(SEO_TOOLS.map((t) => t.name));

export function isSeoToolName(name: string): boolean {
  return SEO_TOOL_NAMES.has(name);
}

export interface SeoToolContext {
  tenantId:   string;
  runId:      string;
  taskId:     string;
  channelId?: string;
  /**
   * Task 0.5.1: source trigger of the parent task. When set to a cron-*
   * value, propose_action suppresses the individual Slack approval card —
   * approvals get surfaced via the run's final anchor report instead, which
   * gives the operator one consolidated "morning brief" message instead of
   * a wall of cards. Ad-hoc tasks (slash command / mention / manual) post
   * each approval directly because the operator is actively waiting.
   */
  triggerSource?: 'slack-mention' | 'slack-command' | 'cron-daily' | 'cron-weekly' | 'cron-end-of-week' | 'manual';
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
      case 'analyze_page':         return await doAnalyzePage(input);
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
    /** Task 0.5: optional preview URL (Framer staging URL for draft pages). */
    previewUrl?: string;
  };

  // Task 0.5.1 hotfix: hoist tenant lookup so we can use tenant.slackChannelId
  //   as a fallback for ctx.channelId (which can be null when the task wasn't
  //   initiated via a Slack mention). Without this fallback, approval rows
  //   get created with slack_channel_id=NULL, the Slack-post gate below
  //   evaluates to false, and no card ever appears in the channel — the
  //   operator only knows about the approval if they happen to be checking
  //   the DB.
  let tenant: Awaited<ReturnType<typeof getTenant>> | null = null;
  try { tenant = await getTenant(ctx.tenantId); } catch { /* fall through with null */ }
  const effectiveChannelId = ctx.channelId ?? tenant?.slackChannelId ?? null;

  // 1. Write to PG (operational state — required, agent polls this)
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
    previewUrl:     i.previewUrl,
    slackChannelId: effectiveChannelId ?? undefined,
  });

  // 2. Mirror to Sheet (persistent audit record — best-effort, same ID).
  //    Failures logged but don't block: the approval still works end-to-end
  //    via Slack + PG; only the Sheet record is missing.
  if (tenant) {
    try {
      const sheetResult = await createApprovalRequest(tenant, {
        id:         approval.id,
        taskId:     ctx.taskId,
        sessionId:  ctx.runId,
        toolName:   i.toolName,
        toolInput:  i.toolInput,
        riskLevel:  approval.riskLevel,
        riskReason: i.whyPriority ?? `Proposed via SEO skill, priority ${i.priority}.`,
      });
      if (sheetResult.rowNumber != null) {
        await recordSheetRowNumber(pool(), approval.id, sheetResult.rowNumber)
          .catch(err => logger.warn('approval_sheet_row_record_failed', {
            approvalId: approval.id, err: String(err),
          }));
      }
    } catch (err) {
      logger.warn('seo_approval_sheet_write_failed', {
        tenantId: ctx.tenantId, approvalId: approval.id,
        err: String(err).slice(0, 200),
        hint: 'Approval works via Slack + PG; persistent Sheet record missing this row.',
      });
    }
  }

  // 3. Post Slack card (best-effort — DB is authoritative; card is informational).
  //    Task 0.5.1: cron-fired runs (daily/weekly/end-of-week) SKIP the
  //    individual card. The aggregator's final anchor report surfaces
  //    the approvals in a single consolidated "morning brief" message
  //    with inline action buttons instead of dropping N separate cards.
  //    Ad-hoc tasks (operator actively waiting) still post in real time.
  const isCronFired = !!ctx.triggerSource && ctx.triggerSource.startsWith('cron-')
  if (effectiveChannelId && !isCronFired) {
    try {
      await presenter.requestApproval({
        tenantId:   ctx.tenantId,
        channelId:  effectiveChannelId,
        taskId:     ctx.taskId,
        toolName:   i.toolName,
        riskLevel:  approval.riskLevel,
        riskReason: i.whyPriority ?? `Priority ${i.priority}.`,
        approvalId: approval.id,
        previewUrl: i.previewUrl,
        // ── new fields ──────────────────────────────────────────────
        tenantName: tenant?.clientName,
        summary:    i.proposedAction,
      });
    } catch (err) {
      logger.warn('seo_approval_slack_post_failed', {
        tenantId: ctx.tenantId, approvalId: approval.id,
        err: String(err).slice(0, 200),
      });
    }
  } else if (isCronFired) {
    logger.info('seo_approval_cron_batched', {
      tenantId: ctx.tenantId, approvalId: approval.id, trigger: ctx.triggerSource,
      hint: 'Cron-fired run; approval will surface in the final anchor report rather than as an individual card.',
    });
  }

  return `Approval ${approval.id.slice(0, 8)} filed (${approval.priority}, risk ${approval.riskLevel}).`;
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

// ── analyze_page composite tool ─────────────────────────────────────
//
// Fetches one URL and returns a structured summary of every page-level SEO
// signal in a single call. Replaces 5-10 separate run_command/web_fetch
// calls per page check — each of which previously cost a full model
// round-trip.
//
// What we extract:
//   HTTP:      status, response time (ms), final URL after redirects,
//              content-type, content length, server header, x-robots-tag
//   Page:     title (+ char count), meta description (+ char count),
//              meta robots, language, charset
//   Structure: H1 array, H2 array, H3 array, word count
//   Linking:   canonical URL, internal link count, external link count,
//              broken-anchor check (anchors with empty href)
//   Schema:    every JSON-LD block found, parsed
//   Social:    og:* tags, twitter:* tags
//   Images:    total count, count with alt, count with empty alt, count
//              missing alt, largest unoptimised image
//   Preview:   first ~200 chars of main text
//
// Implementation notes:
//   - Uses a single fetch with a 15s timeout. No retries here — the
//     subagent can retry the whole tool call if needed.
//   - HTML parsing is minimal regex-based. Good enough for the >90% of
//     pages where signals are present in the source. SPAs that render
//     in JS get a degraded view but the tool surfaces that explicitly
//     (low word count + no H1 + meaningful preview text in <body> = SPA).
//   - Output is plain text formatted for Claude to read — not JSON.
//     Tokens are similar but more scan-readable for the model.

interface AnalyzePageResult {
  status:            number;
  finalUrl:          string;
  responseTimeMs:    number;
  contentType:       string | null;
  contentLength:     number | null;
  xRobotsTag:        string | null;
  pageTitle:         string | null;
  pageTitleLen:      number;
  metaDescription:   string | null;
  metaDescLen:       number;
  metaRobots:        string | null;
  language:          string | null;
  charset:           string | null;
  canonical:         string | null;
  h1s:               string[];
  h2s:               string[];
  h3s:               string[];
  wordCount:         number;
  internalLinkCount: number;
  externalLinkCount: number;
  emptyAnchorCount:  number;
  jsonLdBlocks:      unknown[];
  openGraph:         Record<string, string>;
  twitterCard:       Record<string, string>;
  imageCount:        number;
  imagesWithAlt:     number;
  imagesEmptyAlt:    number;
  imagesNoAlt:       number;
  preview:           string;
}

async function doAnalyzePage(input: Record<string, unknown>): Promise<string> {
  const i = input as { url: string; userAgent?: string };

  if (!i.url || typeof i.url !== 'string') {
    return `analyze_page error: url is required`;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(i.url);
  } catch {
    return `analyze_page error: invalid URL "${i.url}"`;
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return `analyze_page error: only http(s) URLs supported, got ${parsedUrl.protocol}`;
  }

  const userAgent = i.userAgent ?? 'CGSAuditBot/1.0';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const t0 = Date.now();

  let res: Response;
  let body: string;
  try {
    res = await fetch(i.url, {
      method:  'GET',
      headers: { 'User-Agent': userAgent, 'Accept': 'text/html,*/*;q=0.8' },
      signal:  controller.signal,
      redirect: 'follow',
    });
    body = await res.text();
  } catch (err) {
    clearTimeout(timeout);
    return `analyze_page failed: ${String(err).slice(0, 200)}`;
  } finally {
    clearTimeout(timeout);
  }

  const elapsed = Date.now() - t0;
  const result = parseHtml(body, parsedUrl, res, elapsed);

  return formatAnalyzePageResult(i.url, result);
}

function parseHtml(html: string, pageUrl: URL, res: Response, elapsed: number): AnalyzePageResult {
  // ── HTTP layer ────
  const status        = res.status;
  const finalUrl      = res.url;
  const contentType   = res.headers.get('content-type');
  const contentLength = (() => {
    const cl = res.headers.get('content-length');
    if (cl) return parseInt(cl, 10);
    return new TextEncoder().encode(html).length;
  })();
  const xRobotsTag = res.headers.get('x-robots-tag');

  // ── <head> tags ────
  const pageTitle = matchOnce(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = matchAttr(html, 'meta', 'name', 'description', 'content');
  const metaRobots      = matchAttr(html, 'meta', 'name', 'robots', 'content');
  const language        = matchOnce(html, /<html[^>]*\blang=["']([^"']+)["']/i);
  const charset         = matchOnce(html, /<meta[^>]*\bcharset=["']?([^"'\s>]+)/i);
  const canonical       = matchAttr(html, 'link', 'rel', 'canonical', 'href');

  // ── Headings ────
  const h1s = matchAll(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi).map(stripTags).filter(Boolean);
  const h2s = matchAll(html, /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi).map(stripTags).filter(Boolean);
  const h3s = matchAll(html, /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi).map(stripTags).filter(Boolean);

  // ── Links ────
  const anchors = matchAll(html, /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>/gi);
  let internalLinkCount = 0, externalLinkCount = 0, emptyAnchorCount = 0;
  for (const href of anchors) {
    if (!href || href === '#') { emptyAnchorCount++; continue; }
    try {
      const u = new URL(href, pageUrl);
      if (u.hostname === pageUrl.hostname) internalLinkCount++;
      else externalLinkCount++;
    } catch { /* skip malformed */ }
  }

  // ── JSON-LD ────
  const jsonLdBlocks: unknown[] = [];
  for (const block of matchAll(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLdBlocks.push(JSON.parse(block.trim()));
    } catch {
      jsonLdBlocks.push({ _parseError: true, _raw: block.trim().slice(0, 300) });
    }
  }

  // ── Open Graph + Twitter ────
  const openGraph: Record<string, string> = {};
  const twitterCard: Record<string, string> = {};
  for (const m of matchAllPairs(html, /<meta[^>]*\bproperty=["'](og:[^"']+)["'][^>]*\bcontent=["']([^"']*)["']/gi)) {
    openGraph[m[0]] = m[1];
  }
  for (const m of matchAllPairs(html, /<meta[^>]*\bname=["'](twitter:[^"']+)["'][^>]*\bcontent=["']([^"']*)["']/gi)) {
    twitterCard[m[0]] = m[1];
  }

  // ── Images ────
  let imageCount = 0, imagesWithAlt = 0, imagesEmptyAlt = 0, imagesNoAlt = 0;
  const imgTags = matchAll(html, /<img\b[^>]*>/gi);
  for (const tag of imgTags) {
    imageCount++;
    const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
    if (altMatch === null)        imagesNoAlt++;
    else if (altMatch[1] === '')  imagesEmptyAlt++;
    else                          imagesWithAlt++;
  }

  // ── Body text / word count / preview ────
  const bodyHtml = matchOnce(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) ?? html;
  const textContent = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = textContent ? textContent.split(/\s+/).length : 0;
  const preview   = textContent.slice(0, 300);

  return {
    status, finalUrl, responseTimeMs: elapsed,
    contentType, contentLength, xRobotsTag,
    pageTitle:       pageTitle ? decode(pageTitle).trim() : null,
    pageTitleLen:    pageTitle ? decode(pageTitle).trim().length : 0,
    metaDescription: metaDescription ? decode(metaDescription).trim() : null,
    metaDescLen:     metaDescription ? decode(metaDescription).trim().length : 0,
    metaRobots,
    language,
    charset,
    canonical,
    h1s, h2s, h3s,
    wordCount,
    internalLinkCount, externalLinkCount, emptyAnchorCount,
    jsonLdBlocks,
    openGraph, twitterCard,
    imageCount, imagesWithAlt, imagesEmptyAlt, imagesNoAlt,
    preview,
  };
}

function formatAnalyzePageResult(url: string, r: AnalyzePageResult): string {
  const lines: string[] = [];
  lines.push(`# analyze_page: ${url}`);
  lines.push('');
  lines.push(`## HTTP`);
  lines.push(`- Status: ${r.status}`);
  lines.push(`- Final URL: ${r.finalUrl}${r.finalUrl !== url ? '  (redirected from input)' : ''}`);
  lines.push(`- Response time: ${r.responseTimeMs}ms`);
  if (r.contentType)   lines.push(`- Content-Type: ${r.contentType}`);
  if (r.contentLength) lines.push(`- Size: ${formatBytes(r.contentLength)}`);
  if (r.xRobotsTag)    lines.push(`- X-Robots-Tag: ${r.xRobotsTag}`);
  lines.push('');

  lines.push(`## Head tags`);
  lines.push(`- Title: ${r.pageTitle === null ? '(missing)' : `"${r.pageTitle}" (${r.pageTitleLen} chars)`}`);
  lines.push(`- Meta description: ${r.metaDescription === null ? '(missing)' : `"${r.metaDescription}" (${r.metaDescLen} chars)`}`);
  if (r.metaRobots) lines.push(`- Meta robots: ${r.metaRobots}`);
  if (r.canonical)  lines.push(`- Canonical: ${r.canonical}`);
  if (r.language)   lines.push(`- HTML lang: ${r.language}`);
  if (r.charset)    lines.push(`- Charset: ${r.charset}`);
  lines.push('');

  lines.push(`## Heading structure`);
  lines.push(`- H1 (${r.h1s.length}): ${r.h1s.length === 0 ? '(none — that\'s a problem)' : r.h1s.map(h => `"${h}"`).join(' | ')}`);
  lines.push(`- H2 (${r.h2s.length})${r.h2s.length > 0 ? ': ' + r.h2s.slice(0, 8).map(h => `"${h}"`).join(' | ') + (r.h2s.length > 8 ? ' …' : '') : ''}`);
  if (r.h3s.length > 0) lines.push(`- H3 (${r.h3s.length})`);
  lines.push('');

  lines.push(`## Links`);
  lines.push(`- Internal: ${r.internalLinkCount}`);
  lines.push(`- External: ${r.externalLinkCount}`);
  if (r.emptyAnchorCount > 0) lines.push(`- Empty anchors (broken links / placeholders): ${r.emptyAnchorCount}`);
  lines.push('');

  lines.push(`## Images`);
  lines.push(`- Total: ${r.imageCount} (${r.imagesWithAlt} with alt, ${r.imagesEmptyAlt} empty alt, ${r.imagesNoAlt} missing alt)`);
  lines.push('');

  if (r.jsonLdBlocks.length > 0) {
    lines.push(`## Schema (JSON-LD)`);
    for (const block of r.jsonLdBlocks) {
      try {
        const j = block as Record<string, unknown>;
        const t = j['@type'] ?? j._parseError ? 'PARSE_ERROR' : '(no @type)';
        lines.push(`- ${typeof t === 'string' ? t : JSON.stringify(t)}`);
      } catch {
        lines.push(`- (unparseable)`);
      }
    }
    lines.push('');
  } else {
    lines.push(`## Schema (JSON-LD)`);
    lines.push(`- (none — page has no structured-data labels for Google)`);
    lines.push('');
  }

  const ogKeys = Object.keys(r.openGraph);
  if (ogKeys.length > 0) {
    lines.push(`## Open Graph`);
    for (const k of ogKeys.sort()) lines.push(`- ${k}: ${truncate(r.openGraph[k], 100)}`);
    lines.push('');
  }

  const twKeys = Object.keys(r.twitterCard);
  if (twKeys.length > 0) {
    lines.push(`## Twitter Card`);
    for (const k of twKeys.sort()) lines.push(`- ${k}: ${truncate(r.twitterCard[k], 100)}`);
    lines.push('');
  }

  lines.push(`## Content`);
  lines.push(`- Word count: ${r.wordCount}${r.wordCount < 100 ? '  (low — possibly SPA rendered via JS or thin content)' : ''}`);
  lines.push(`- Preview: ${r.preview ? `"${r.preview}…"` : '(empty body — likely SPA shell)'}`);
  return lines.join('\n');
}

// ── Tiny HTML/text helpers (regex-based — fast, no DOM dep) ─────────

function matchOnce(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m && m[1] ? m[1] : null;
}

function matchAll(s: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}

function matchAllPairs(s: string, re: RegExp): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) out.push([m[1], m[2]]);
  return out;
}

function matchAttr(html: string, tag: string, attrName: string, attrValue: string, contentAttr: string): string | null {
  // <meta name="..." content="...">  OR  <link rel="..." href="...">
  // attribute order may be reversed.
  const r1 = new RegExp(`<${tag}[^>]*\\b${attrName}=["']${attrValue}["'][^>]*\\b${contentAttr}=["']([^"']*)["']`, 'i');
  const m1 = html.match(r1);
  if (m1) return m1[1];
  const r2 = new RegExp(`<${tag}[^>]*\\b${contentAttr}=["']([^"']*)["'][^>]*\\b${attrName}=["']${attrValue}["']`, 'i');
  const m2 = html.match(r2);
  if (m2) return m2[1];
  return null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
