// src/skills/seo-discovery/index.ts
//
// Phase 2, unit 3: action-oriented discovery cycles. Each cycle reads the
// strategy doc (scope + cluster-fit), pulls history via the shared loader,
// computes real EV via the unit-1 scorer, and files scored opportunities
// through the shared primitive.

export {
  buildClusterFitResolver, buildResolverFromCore, weightForDisposition,
  pickClusterFitKeyword, blendClusterFit, keywordInPhrases,
} from './cluster-fit'
export type { ClusterFitResolver } from './cluster-fit'
export { buildConversionRateResolver } from './conversion-rate'
export type { ConversionRateResolver } from './conversion-rate'
export { fileScoredOpportunity, executionModeFor, isCmsTarget } from './file-opportunity'
export type { FileCandidate, FileResult, DiscoveryResolvers } from './file-opportunity'
export { loadRankingRows, groupByPage, MIN_QUERY_IMPRESSIONS } from './common'
export type { RankingRow } from './common'
export { runMetadataEditCycle } from './metadata-edit'
export { runCopyOptimiseCycle } from './copy-optimise'
export { runInternalLinkCycle } from './internal-link'
export { runArticleCreateCycle } from './article-create'
