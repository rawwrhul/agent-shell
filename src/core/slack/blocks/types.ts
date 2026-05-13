// src/core/slack/blocks/types.ts
// Shared types for structured FinalReport objects produced by the aggregator
// and rendered by the Slack presenter.

import type { RiskLevel } from '../../../types'

// ── Ad-hoc check report ───────────────────────────────────────────────────

export interface AdHocFinding {
  severity: 'critical' | 'high' | 'medium' | 'low'
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  text:     string
  meta?:    string
}

export interface AdHocLeverage {
  priority:  'P0' | 'P1' | 'P2' | 'P3'
  title:     string
  detail:    string
  estImpact: string
}

export interface AdHocCheckReport {
  kind:      'ad_hoc'
  title:     string
  subtitle?: string
  tldr:      string[]
  broken:    AdHocFinding[]
  working:   string[]
  leverage:  AdHocLeverage[]
  // Identity fields (attached by aggregator, not emitted by LLM)
  tenantName?: string
  tenantSlug?: string
  runId?:      string
}

// ── Daily run report ──────────────────────────────────────────────────────

export interface ShippedAction {
  id:          string
  title:       string
  detail?:     string
  executedAt:  string
  status:      'success' | 'partial'
}

export interface NewOpportunity {
  id:          string
  description: string
  priority:    'P0' | 'P1' | 'P2'
}

export interface QueuedAction {
  id:               string
  title:            string
  estimateMinutes?: number
}

export interface AwaitingApproval {
  id:           string
  title:        string
  detail?:      string
  pendingSince: string
  severity:     'critical' | 'high' | 'medium' | 'low'
  approvalUrl?: string
}

export interface DailyRunReport {
  kind:              'daily'
  tldr:              string[]
  shippedActions:    ShippedAction[]
  newOpportunities:  NewOpportunity[]
  queuedForToday:    QueuedAction[]
  awaitingApproval:  AwaitingApproval[]
  // Identity fields
  tenantName?: string
  tenantSlug?: string
  runId?:      string
  runDate?:    Date
  trigger?:    'cron' | 'on_demand'
}

// ── Weekly audit report ───────────────────────────────────────────────────

export interface WeeklySummary {
  actionsShipped:      number
  clusterBriefsLanded: number
  rankingsImproved:    number
  riskFlags:           number
}

export interface StateOfPlay {
  label:          string
  value:          string
  delta?:         string
  deltaDirection: 'up' | 'down' | 'flat'
}

export interface TopPriority {
  rank:   'P0' | 'P1' | 'P2'
  title:  string
  detail: string
  impact: 'high' | 'med' | 'low'
}

export interface ClusterProgress {
  pillarTopic:    string
  state:          'planned' | 'in_progress' | 'complete'
  briefsLanded:   number
  briefsTotal:    number
  awaitingPublish: number
  detail?:        string
}

export interface RiskFlag {
  title:    string
  detail?:  string
  severity: 'monitor' | 'act_soon' | 'urgent'
}

export interface WeeklyAuditReport {
  kind:                'weekly'
  tldr:                string[]
  summary:             WeeklySummary
  stateOfPlay:         StateOfPlay[]
  topPriorities:       TopPriority[]
  clusterProgress:     ClusterProgress[]
  riskFlags:           RiskFlag[]
  approvalQueueCount:  number
  // Identity fields
  tenantName?: string
  tenantSlug?: string
  runId?:      string
  weekStart?:  Date
  trigger?:    'cron' | 'on_demand'
}

// ── Union ─────────────────────────────────────────────────────────────────

export type FinalReport = AdHocCheckReport | DailyRunReport | WeeklyAuditReport

// ── Approval card types ───────────────────────────────────────────────────

export interface ApprovalCardData {
  approvalId:     string
  toolName:       string
  proposedAction: string
  whyPriority:    string
  riskLevel:      RiskLevel
  requestedAt:    Date
  specialistType: string
}

// Re-export for convenience
export type { RiskLevel }
