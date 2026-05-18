// src/core/opportunity-bank/index.ts
//
// Public API for the opportunity bank. Consumers (aggregator, slackManager,
// hitl handlers) import from here, not from individual files.

export {
  pickForDailyRun,
  pickForAdHoc,
  scoreAndPick,
} from './select'

export {
  markRejected,
  markStaleByAge,
  linkApprovalToOpportunity,
  linkReshapeDescendant,
  getOpportunityForApproval,
} from './transitions'

export {
  handleRejectionOnOpportunity,
  isFlatRejection,
  reshapeOpportunity,
} from './reshape'

export {
  matchAdHocRequest,
  KNOWN_OPPORTUNITY_TYPES,
} from './ad-hoc-match'

export type {
  Opportunity,
  OppStatus,
  Priority,
  AdHocMatch,
} from './types'

export {
  TERMINAL_STATUSES,
  ACTIONABLE_STATUSES,
  PRIORITY_WEIGHTS,
  FRESHNESS_WINDOW_DAYS,
  DIVERSITY_CAP_PER_TYPE,
  RESHAPE_MAX_DEPTH,
  DEFAULT_SURFACE_LIMIT,
  AD_HOC_CONFIDENCE_THRESHOLD,
} from './types'
