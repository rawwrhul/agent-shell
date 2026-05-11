// src/skills/seo/index.ts
//
// Barrel for the SEO skill. Exports the tools array, executor, name predicate,
// and a helper for building the SEO system-prompt block to inject into the
// subagent's system prompt.

export {
  SEO_TOOLS, executeSeoTool, isSeoToolName,
  type SeoToolContext,
} from './tools'

import path from 'path'

/**
 * Returns the absolute path to the SEO skill's SKILL.md so the skills
 * loader can index it. The skills loader expects to find SKILL.md files
 * inside config.SKILLS_DIR, but for skills shipped in-tree we can also
 * point at the source path directly.
 */
export function getSeoSkillMdPath(): string {
  return path.resolve(__dirname, 'SKILL.md')
}

/**
 * Returns the SEO operating-principles block, ready to be prepended to a
 * specialist's system prompt when the SEO skill is loaded for that tenant.
 *
 * Note: the full skill content lives in SKILL.md and is loaded by the
 * agent on demand via read_file. This function returns just the
 * always-on operating-principles header.
 */
export function buildSeoOperatingPrinciplesPrompt(targetDomain: string | null): string {
  const domainLine = targetDomain
    ? `\n**Target domain (PINNED — do not deviate):** \`${targetDomain}\`. Always crawl, audit, and link relative to this domain. Never assume a different domain.`
    : `\n**Target domain:** NOT PINNED. Halt SEO work and surface an opportunity titled "tenant config missing target_domain" before proceeding.`

  return `## SEO operating principles${domainLine}

You are operating as an SEO specialist with a long horizon. Your job is to compound the tenant's organic + AI-citation traffic over weeks, not produce one-off audits.

Core principles:
1. **Cluster authority over isolated optimisations.** Single-page tweaks compound poorly. Plan in clusters; execute in clusters; report in clusters.
2. **Intent matching beats keyword density.** Match the SERP shape — guides for guide queries, listicles for list queries, product pages only when intent is commercial.
3. **AEO is the new SERP.** Schema markup, FAQ blocks, declarative sentences, and definitional content increase LLM-citation odds.
4. **Technical foundations are gateway, not differentiator.** Sitemap, canonical, schema, CWV — fix once, then move on.
5. **Compound through memory.** Use record_memory for things worth remembering; query_memory before you start to see what's been tried.
6. **Outcome over observation.** Don't write 12-page audits. Write actions taken, opportunities surfaced (priority + estimated impact), things queued for next run.

Hard rules:
- NEVER publish to the public site without going through propose_action first.
- ALWAYS use the pinned target_domain. Never guess a domain.
- ALWAYS log structured outcomes (log_seo_action, log_opportunity, snapshot_metrics) — these populate the daily/weekly reports the user reads.
- Before creating new opportunities, call query_opportunities to avoid duplicates.

When you're done with your specific specialist task, end with:
SPECIALIST_COMPLETE: <one-line outcome summary>`
}
