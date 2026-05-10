// src/seo/types.ts
//
// Domain types for the SEO layer. DB row shapes are decoupled from the
// Block Kit report types in src/core/slack/blocks/types.ts so the data
// store can evolve independently of the rendering layer.

export type ActionType =
  // Content
  | 'cluster_brief_drafted'
  | 'cluster_page_drafted'
  | 'cluster_page_published'
  | 'meta_description_rewritten'
  | 'meta_title_rewritten'
  | 'alt_text_added'
  // Schema
  | 'schema_added'
  | 'schema_updated'
  // Linking
  | 'internal_link_added'
  | 'orphan_page_resolved'
  // AEO / off-site
  | 'reddit_answer_drafted'
  | 'reddit_answer_posted'
  | 'linkedin_post_drafted'
  | 'linkedin_post_posted'
  | 'quora_answer_drafted'
  | 'quora_answer_posted'
  // Outreach
  | 'backlink_outreach_drafted'
  | 'backlink_outreach_sent'
  // Analysis (no live change)
  | 'gsc_snapshot_captured'
  | 'serp_check_run'
  | 'competitor_audit_run'
  | 'audit_run'
  | 'opportunity_surfaced';

export type ActionStatus =
  | 'success'
  | 'partial'
  | 'failed'
  | 'awaiting_approval'
  | 'queued';

export interface SeoWorkLogRow {
  id: string;
  tenantId: string;
  runId: string;
  actionType: ActionType;
  targetUrl: string | null;     // null for actions that aren't page-specific
  summary: string;              // one-line — used in daily report
  detail: string | null;        // longer description, mrkdwn
  status: ActionStatus;
  executedAt: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export type OpportunityType =
  | 'schema_gap'
  | 'meta_optimization'
  | 'content_gap'
  | 'cluster_expansion'
  | 'internal_link_gap'
  | 'competitor_move'
  | 'serp_opportunity'
  | 'aeo_citation'
  | 'technical_issue';

export type OpportunityStatus =
  | 'new'
  | 'queued'
  | 'in_progress'
  | 'executed'
  | 'rejected'
  | 'stale';

export type Priority = 'P0' | 'P1' | 'P2';

export interface SeoOpportunityRow {
  id: string;
  tenantId: string;
  runId: string;                // run that surfaced it
  type: OpportunityType;
  target: string | null;        // URL, keyword, or topic the opportunity is about
  description: string;          // shown in the daily report
  rationale: string | null;     // why it's high-leverage — used in detail views
  priority: Priority;
  status: OpportunityStatus;
  estimatedImpact: string | null;  // free-form: "+12% est. CTR lift"
  createdAt: Date;
  updatedAt: Date;
  resolvedRunId: string | null; // run that executed the opportunity
}

export interface SeoMetricsSnapshotRow {
  id: string;
  tenantId: string;
  capturedAt: Date;
  indexedPages: number | null;
  rankingKeywords: number | null;
  schemaCoveragePct: number | null;     // 0-100
  avgPosition: number | null;
  aiCitationsEstimated: number | null;
  domainRating: number | null;
  /** Catch-all for source-specific fields (GSC raw, DataForSEO raw etc.) */
  rawSources: Record<string, unknown>;
}

export type ClusterState = 'planned' | 'in_progress' | 'complete' | 'paused';

export interface SeoClusterRow {
  id: string;
  tenantId: string;
  pillarTopic: string;          // "Hire offshore in Australia"
  pillarUrl: string | null;     // canonical pillar page URL once it exists
  state: ClusterState;
  briefsTotal: number;          // planned size of the cluster
  briefsDrafted: number;
  briefsPublished: number;
  awaitingPublish: number;      // drafts ready, blocked on HITL
  detail: string | null;        // free-form notes
  createdAt: Date;
  updatedAt: Date;
}

// ── Filter types for queries ────────────────────────────────────────

export interface WorkLogQuery {
  tenantId: string;
  since?: Date;
  until?: Date;
  status?: ActionStatus | ActionStatus[];
  actionType?: ActionType | ActionType[];
  limit?: number;
}

export interface OpportunityQuery {
  tenantId: string;
  status?: OpportunityStatus | OpportunityStatus[];
  priority?: Priority | Priority[];
  since?: Date;
  limit?: number;
}

// ── Aggregations ────────────────────────────────────────────────────

export interface WeeklyMetricDelta {
  current: SeoMetricsSnapshotRow;
  previous: SeoMetricsSnapshotRow | null;
}

export interface WeeklySummary {
  actionsShipped: number;
  clusterBriefsLanded: number;
  rankingsImproved: number;
  riskFlags: number;
}
