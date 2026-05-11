// src/core/slack/blocks/index.ts
//
// Barrel export. Other modules import block builders and types from here:
//
//   import { renderAnchor, renderDailyRun } from '@/core/slack/blocks';
//   import type { DailyRunReport, FinalReport } from '@/core/slack/blocks';

export * from './types';
export * from './shared';
export { renderAnchor } from './anchor';
export type { AnchorState, RunPhase, SpecialistState } from './anchor';
export {
  renderSpecialistThread,
} from './thread-specialist';
export type { SpecialistThreadReply } from './thread-specialist';
export {
  renderFinalReportThread,
} from './thread-final';
export type {
  FinalReportThreadReply,
  ReportSection,
} from './thread-final';
export {
  renderApprovalRequest,
  renderApprovalResolved,
} from './approval';
export type {
  ApprovalRequest,
  ApprovalResolution,
  ApprovalActionKind,
} from './approval';
export { renderDailyRun } from './daily-run';
export { renderWeeklyAudit } from './weekly-audit';

// ── R3 additions ────────────────────────────────────────────────────
export { renderAdHocCheck } from './ad-hoc-check';
export type { AdHocCheckRenderContext } from './ad-hoc-check';
