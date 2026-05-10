// src/seo/data-store.ts
//
// Read/write layer for the SEO state tables. All functions take a `pg.Pool`
// or `pg.PoolClient` so callers can run them inside an existing transaction
// (e.g. when the orchestrator wants to log multiple actions atomically).
//
// Naming convention:
//   - logXxx / recordXxx       — write
//   - getXxx / listXxx         — read
//   - summariseXxx             — aggregations used by reports

import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  SeoWorkLogRow,
  SeoOpportunityRow,
  SeoMetricsSnapshotRow,
  SeoClusterRow,
  WorkLogQuery,
  OpportunityQuery,
  WeeklyMetricDelta,
  WeeklySummary,
  ActionType,
  ActionStatus,
  OpportunityType,
  OpportunityStatus,
  Priority,
  ClusterState,
} from './types';

type Db = Pool | PoolClient;

// ── Work log ────────────────────────────────────────────────────────

export interface LogActionInput {
  tenantId: string;
  runId: string;
  actionType: ActionType;
  targetUrl?: string | null;
  summary: string;
  detail?: string | null;
  status?: ActionStatus;
  executedAt?: Date;
  metadata?: Record<string, unknown>;
}

export async function logAction(db: Db, input: LogActionInput): Promise<SeoWorkLogRow> {
  const id = randomUUID();
  const executedAt = input.executedAt ?? new Date();
  const status: ActionStatus = input.status ?? 'success';
  const metadata = input.metadata ?? {};

  const { rows } = await db.query(
    `INSERT INTO seo_work_log
       (id, tenant_id, run_id, action_type, target_url, summary, detail,
        status, executed_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      id,
      input.tenantId,
      input.runId,
      input.actionType,
      input.targetUrl ?? null,
      input.summary,
      input.detail ?? null,
      status,
      executedAt,
      JSON.stringify(metadata),
    ]
  );

  return mapWorkLogRow(rows[0]);
}

export async function listWorkLog(db: Db, q: WorkLogQuery): Promise<SeoWorkLogRow[]> {
  const where: string[] = ['tenant_id = $1'];
  const params: unknown[] = [q.tenantId];

  if (q.since) {
    params.push(q.since);
    where.push(`executed_at >= $${params.length}`);
  }
  if (q.until) {
    params.push(q.until);
    where.push(`executed_at < $${params.length}`);
  }
  if (q.status) {
    const statuses = Array.isArray(q.status) ? q.status : [q.status];
    params.push(statuses);
    where.push(`status = ANY($${params.length})`);
  }
  if (q.actionType) {
    const types = Array.isArray(q.actionType) ? q.actionType : [q.actionType];
    params.push(types);
    where.push(`action_type = ANY($${params.length})`);
  }

  const limit = q.limit ?? 200;
  params.push(limit);

  const sql =
    `SELECT * FROM seo_work_log
     WHERE ${where.join(' AND ')}
     ORDER BY executed_at DESC
     LIMIT $${params.length}`;

  const { rows } = await db.query(sql, params);
  return rows.map(mapWorkLogRow);
}

/** Used by the daily report. Returns actions executed since the last completed run. */
export async function listActionsSinceLastRun(
  db: Db,
  tenantId: string,
  currentRunId: string
): Promise<SeoWorkLogRow[]> {
  // Find the previous run's start time (any run other than the current one).
  const { rows: prev } = await db.query(
    `SELECT MAX(executed_at) AS last_at
     FROM seo_work_log
     WHERE tenant_id = $1 AND run_id <> $2`,
    [tenantId, currentRunId]
  );
  const since = prev[0]?.last_at as Date | null;
  if (!since) {
    // First run for this tenant — return everything from this run only.
    return listWorkLog(db, { tenantId, limit: 100 });
  }
  return listWorkLog(db, { tenantId, since, limit: 100 });
}

// ── Opportunities ───────────────────────────────────────────────────

export interface RecordOpportunityInput {
  tenantId: string;
  runId: string;
  type: OpportunityType;
  target?: string | null;
  description: string;
  rationale?: string | null;
  priority: Priority;
  estimatedImpact?: string | null;
}

export async function recordOpportunity(
  db: Db,
  input: RecordOpportunityInput
): Promise<SeoOpportunityRow> {
  const id = randomUUID();
  const now = new Date();

  const { rows } = await db.query(
    `INSERT INTO seo_opportunities
       (id, tenant_id, run_id, type, target, description, rationale, priority,
        status, estimated_impact, created_at, updated_at, resolved_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new', $9, $10, $10, NULL)
     RETURNING *`,
    [
      id,
      input.tenantId,
      input.runId,
      input.type,
      input.target ?? null,
      input.description,
      input.rationale ?? null,
      input.priority,
      input.estimatedImpact ?? null,
      now,
    ]
  );
  return mapOpportunityRow(rows[0]);
}

export async function listOpportunities(
  db: Db,
  q: OpportunityQuery
): Promise<SeoOpportunityRow[]> {
  const where: string[] = ['tenant_id = $1'];
  const params: unknown[] = [q.tenantId];

  if (q.status) {
    const statuses = Array.isArray(q.status) ? q.status : [q.status];
    params.push(statuses);
    where.push(`status = ANY($${params.length})`);
  }
  if (q.priority) {
    const priorities = Array.isArray(q.priority) ? q.priority : [q.priority];
    params.push(priorities);
    where.push(`priority = ANY($${params.length})`);
  }
  if (q.since) {
    params.push(q.since);
    where.push(`created_at >= $${params.length}`);
  }
  const limit = q.limit ?? 50;
  params.push(limit);

  const { rows } = await db.query(
    `SELECT * FROM seo_opportunities
     WHERE ${where.join(' AND ')}
     ORDER BY priority ASC, created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map(mapOpportunityRow);
}

/** Surfaced for the first time in the current run. */
export async function listNewOpportunitiesForRun(
  db: Db,
  tenantId: string,
  runId: string
): Promise<SeoOpportunityRow[]> {
  const { rows } = await db.query(
    `SELECT * FROM seo_opportunities
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY priority ASC, created_at ASC`,
    [tenantId, runId]
  );
  return rows.map(mapOpportunityRow);
}

export async function updateOpportunityStatus(
  db: Db,
  id: string,
  status: OpportunityStatus,
  resolvedRunId?: string
): Promise<void> {
  await db.query(
    `UPDATE seo_opportunities
     SET status = $2,
         resolved_run_id = COALESCE($3, resolved_run_id),
         updated_at = NOW()
     WHERE id = $1`,
    [id, status, resolvedRunId ?? null]
  );
}

// ── Metrics snapshots ───────────────────────────────────────────────

export interface CaptureSnapshotInput {
  tenantId: string;
  capturedAt?: Date;
  indexedPages?: number | null;
  rankingKeywords?: number | null;
  schemaCoveragePct?: number | null;
  avgPosition?: number | null;
  aiCitationsEstimated?: number | null;
  domainRating?: number | null;
  rawSources?: Record<string, unknown>;
}

export async function captureSnapshot(
  db: Db,
  input: CaptureSnapshotInput
): Promise<SeoMetricsSnapshotRow> {
  const id = randomUUID();
  const capturedAt = input.capturedAt ?? new Date();

  const { rows } = await db.query(
    `INSERT INTO seo_metrics_snapshots
       (id, tenant_id, captured_at, indexed_pages, ranking_keywords,
        schema_coverage_pct, avg_position, ai_citations_estimated,
        domain_rating, raw_sources)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      id,
      input.tenantId,
      capturedAt,
      input.indexedPages ?? null,
      input.rankingKeywords ?? null,
      input.schemaCoveragePct ?? null,
      input.avgPosition ?? null,
      input.aiCitationsEstimated ?? null,
      input.domainRating ?? null,
      JSON.stringify(input.rawSources ?? {}),
    ]
  );
  return mapSnapshotRow(rows[0]);
}

/**
 * Returns the most recent snapshot, plus the closest snapshot from ~7 days
 * earlier for week-over-week deltas in the weekly audit.
 */
export async function getWeeklySnapshotDelta(
  db: Db,
  tenantId: string,
  asOf: Date = new Date()
): Promise<WeeklyMetricDelta | null> {
  const { rows: currentRows } = await db.query(
    `SELECT * FROM seo_metrics_snapshots
     WHERE tenant_id = $1 AND captured_at <= $2
     ORDER BY captured_at DESC LIMIT 1`,
    [tenantId, asOf]
  );
  if (currentRows.length === 0) return null;
  const current = mapSnapshotRow(currentRows[0]);

  const sevenDaysAgo = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000);
  const window = 2 * 24 * 60 * 60 * 1000;        // ±2 days

  const { rows: prevRows } = await db.query(
    `SELECT * FROM seo_metrics_snapshots
     WHERE tenant_id = $1
       AND captured_at >= $2
       AND captured_at <= $3
     ORDER BY ABS(EXTRACT(EPOCH FROM (captured_at - $4))) ASC
     LIMIT 1`,
    [
      tenantId,
      new Date(sevenDaysAgo.getTime() - window),
      new Date(sevenDaysAgo.getTime() + window),
      sevenDaysAgo,
    ]
  );

  return {
    current,
    previous: prevRows.length > 0 ? mapSnapshotRow(prevRows[0]) : null,
  };
}

// ── Clusters ────────────────────────────────────────────────────────

export interface UpsertClusterInput {
  tenantId: string;
  pillarTopic: string;
  pillarUrl?: string | null;
  state: ClusterState;
  briefsTotal: number;
  briefsDrafted: number;
  briefsPublished: number;
  awaitingPublish: number;
  detail?: string | null;
}

export async function upsertCluster(
  db: Db,
  input: UpsertClusterInput
): Promise<SeoClusterRow> {
  // Upsert by (tenant_id, pillar_topic).
  const { rows } = await db.query(
    `INSERT INTO seo_clusters
       (id, tenant_id, pillar_topic, pillar_url, state, briefs_total,
        briefs_drafted, briefs_published, awaiting_publish, detail,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (tenant_id, pillar_topic) DO UPDATE
       SET pillar_url        = EXCLUDED.pillar_url,
           state             = EXCLUDED.state,
           briefs_total      = EXCLUDED.briefs_total,
           briefs_drafted    = EXCLUDED.briefs_drafted,
           briefs_published  = EXCLUDED.briefs_published,
           awaiting_publish  = EXCLUDED.awaiting_publish,
           detail            = EXCLUDED.detail,
           updated_at        = NOW()
     RETURNING *`,
    [
      input.tenantId,
      input.pillarTopic,
      input.pillarUrl ?? null,
      input.state,
      input.briefsTotal,
      input.briefsDrafted,
      input.briefsPublished,
      input.awaitingPublish,
      input.detail ?? null,
    ]
  );
  return mapClusterRow(rows[0]);
}

export async function listClusters(
  db: Db,
  tenantId: string
): Promise<SeoClusterRow[]> {
  const { rows } = await db.query(
    `SELECT * FROM seo_clusters
     WHERE tenant_id = $1
     ORDER BY
       CASE state
         WHEN 'in_progress' THEN 1
         WHEN 'planned'     THEN 2
         WHEN 'paused'      THEN 3
         WHEN 'complete'    THEN 4
       END,
       created_at ASC`,
    [tenantId]
  );
  return rows.map(mapClusterRow);
}

// ── Aggregations ────────────────────────────────────────────────────

/**
 * Build the headline summary for the weekly audit. Counts work shipped,
 * cluster briefs landed, and the number of priority keywords whose rank
 * improved week-over-week (gauged against the previous snapshot).
 */
export async function summariseWeek(
  db: Db,
  tenantId: string,
  weekStart: Date,
  weekEnd: Date = new Date()
): Promise<WeeklySummary> {
  const { rows: actionRows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'success' OR status = 'partial') AS shipped,
       COUNT(*) FILTER (WHERE action_type IN ('cluster_brief_drafted',
                                              'cluster_page_drafted',
                                              'cluster_page_published')) AS cluster_briefs
     FROM seo_work_log
     WHERE tenant_id = $1 AND executed_at >= $2 AND executed_at < $3`,
    [tenantId, weekStart, weekEnd]
  );

  const delta = await getWeeklySnapshotDelta(db, tenantId, weekEnd);
  let rankingsImproved = 0;
  if (delta?.previous && delta.current.avgPosition !== null && delta.previous.avgPosition !== null) {
    // Use ranking_keywords delta as a coarse proxy when no per-keyword tracking.
    const cur = delta.current.rankingKeywords ?? 0;
    const prev = delta.previous.rankingKeywords ?? 0;
    rankingsImproved = Math.max(0, cur - prev);
  }

  const { rows: riskRows } = await db.query(
    `SELECT COUNT(*) AS n FROM seo_opportunities
     WHERE tenant_id = $1
       AND priority = 'P0'
       AND status IN ('new', 'queued')
       AND created_at >= $2`,
    [tenantId, weekStart]
  );

  return {
    actionsShipped: Number(actionRows[0]?.shipped ?? 0),
    clusterBriefsLanded: Number(actionRows[0]?.cluster_briefs ?? 0),
    rankingsImproved,
    riskFlags: Number(riskRows[0]?.n ?? 0),
  };
}

// ── Row mappers ─────────────────────────────────────────────────────
//
// Postgres returns snake_case; the app uses camelCase. Mapping is
// centralised here so the rest of the codebase stays type-safe.

function mapWorkLogRow(row: any): SeoWorkLogRow {
  return {
    id:          row.id,
    tenantId:    row.tenant_id,
    runId:       row.run_id,
    actionType:  row.action_type,
    targetUrl:   row.target_url,
    summary:     row.summary,
    detail:      row.detail,
    status:      row.status,
    executedAt:  row.executed_at,
    metadata:    row.metadata ?? {},
    createdAt:   row.created_at,
  };
}

function mapOpportunityRow(row: any): SeoOpportunityRow {
  return {
    id:                row.id,
    tenantId:          row.tenant_id,
    runId:             row.run_id,
    type:              row.type,
    target:            row.target,
    description:       row.description,
    rationale:         row.rationale,
    priority:          row.priority,
    status:            row.status,
    estimatedImpact:   row.estimated_impact,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
    resolvedRunId:     row.resolved_run_id,
  };
}

function mapSnapshotRow(row: any): SeoMetricsSnapshotRow {
  return {
    id:                    row.id,
    tenantId:              row.tenant_id,
    capturedAt:            row.captured_at,
    indexedPages:          row.indexed_pages,
    rankingKeywords:       row.ranking_keywords,
    schemaCoveragePct:     row.schema_coverage_pct,
    avgPosition:           row.avg_position !== null ? Number(row.avg_position) : null,
    aiCitationsEstimated:  row.ai_citations_estimated,
    domainRating:          row.domain_rating,
    rawSources:            row.raw_sources ?? {},
  };
}

function mapClusterRow(row: any): SeoClusterRow {
  return {
    id:               row.id,
    tenantId:         row.tenant_id,
    pillarTopic:      row.pillar_topic,
    pillarUrl:        row.pillar_url,
    state:            row.state,
    briefsTotal:      row.briefs_total,
    briefsDrafted:    row.briefs_drafted,
    briefsPublished:  row.briefs_published,
    awaitingPublish:  row.awaiting_publish,
    detail:           row.detail,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}
