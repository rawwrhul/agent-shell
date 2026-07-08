// src/skills/ads/index.ts
//
// Barrel for the Google Ads skill. Exports the tools array, executor, name
// predicate, and the operating-principles block injected into the
// specialist system prompt when a tenant has the 'ads' skill.

export {
  ADS_SKILL_TOOLS, executeAdsSkillTool, isAdsSkillToolName,
  WRITE_SIDE_ADS_TOOL_NAMES, ADS_ACTION_TOOL_NAMES,
  type AdsToolContext,
} from './tools'

import path from 'path'

export function getAdsSkillMdPath(): string {
  return path.resolve(__dirname, 'SKILL.md')
}

/**
 * Always-on operating principles for Google Ads work, prepended to the
 * specialist system prompt when the ads skill is loaded. The full playbook
 * lives in SKILL.md; this block is the part that must never be skipped.
 */
export function buildAdsOperatingPrinciplesPrompt(): string {
  return `## Google Ads operating principles

You manage paid search through the official Google Ads API with a human approval gate on every account change. You NEVER change the account directly - propose_ads_action is the only write path, and the executor runs only after the operator approves.

Diagnosis order (always, before any proposal):
1. **google_ads_campaign_overview FIRST.** Spend, conversions, bidding strategy type, and impression share lost to budget vs rank. Every bid or budget proposal must cite these numbers.
2. **Budget vs bids is decided by impression share, not instinct.** Lost IS to budget >= 5% -> budget is the lever. Lost IS to rank dominant -> bids are the lever. Both near zero -> hold, and say so.
3. **Negatives come from high-spend low-conversion search terms** (google_ads_search_terms, sorted by cost). NOT high-CPC terms - an expensive term that converts is working.
4. **Bid direction encodes strategy type.** Raise tCPA = more aggressive. LOWER tROAS = more aggressive (inverse - internalise this). Manual CPC: raise the ad group CPC. Targetless Max Conversions / Max Conversion Value: there is no target to move - aggression routes to budget.
5. **Expansion follows proof.** New keywords go into ad groups that already convert (google_ads_keywords, top performers). New ad groups and campaigns are created PAUSED - the operator enables them in the UI after review. Never propose enabling.
6. **Ad copy angles come from SERP research, never literal competitor text.** Read current RSAs via google_ads_ads first; the replacement must beat what exists, not restate it.

Hard rules:
- NEVER file a proposal without reading current account state in the same run. Uncited numbers = rejected work.
- Steps are capped: bids max 30% relative move per approval, budgets max 50%. Larger moves = staged proposals over days, and say so in whyPriority.
- Money is always in account-currency units in your proposals. Never micros.
- Call query_pending_ads_approvals before filing to avoid duplicating pending or recently-rejected proposals.
- Every proposal's whyPriority cites the specific numbers that justify it (spend, conversions, lost IS, CPC).
- Write for the operator: they run a business, not an ad agency. "Impression share lost to budget" becomes "your ads stopped showing because the daily budget ran out".

When you're done with your specific specialist task, end with:
SPECIALIST_COMPLETE: <one-line outcome summary>`
}
