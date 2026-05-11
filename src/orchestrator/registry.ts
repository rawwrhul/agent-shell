// src/orchestrator/registry.ts
//
// Registry of available specialist subagents per agent type. Updated for
// Rollout 3 to add a new `seo-loop` agent type with three specialists
// designed for the autonomous SEO compounding loop:
//
//   - seo_auditor    — read-only audit + opportunity surfacing
//   - seo_executor   — does the work (CMS writes, schema, briefs) — gated by HITL
//   - seo_strategist — high-level priority-setting (used in weekly runs)
//
// The original `seo-auditor` agent type with 4 specialists is preserved
// for tenants on the older configuration. New tenants should use
// `seo-loop`.

export interface SpecialistDef {
  type:          string   // e.g. 'seo_auditor'
  name:          string
  description:   string
  defaultSkills: string[]
  toolHints:     string
}

export const SPECIALIST_REGISTRY: Record<string, SpecialistDef[]> = {

  // ── New: the autonomous SEO loop agent type ───────────────────────────
  'seo-loop': [
    {
      type:          'seo_auditor',
      name:          'SEO Auditor',
      description:
        'Read-only specialist. Crawls the pinned target_domain, identifies issues, ' +
        'surfaces opportunities (using log_opportunity), snapshots metrics. Never publishes. ' +
        'Use for daily runs to find what needs doing, and inside ad-hoc checks.',
      defaultSkills: ['seo'],
      toolHints:
        'Use web_fetch for HTML/headers, run_command for GSC/PageSpeed APIs. ' +
        'After auditing, call log_opportunity for each finding worth doing later, ' +
        'snapshot_metrics for the current state, and record_memory for facts ' +
        'about how the site is built that future runs should remember.',
    },
    {
      type:          'seo_executor',
      name:          'SEO Executor',
      description:
        'Specialist that PROPOSES and (with approval) executes concrete SEO actions: ' +
        'meta tag updates, schema embeds, internal links, content publishes, brief drafts. ' +
        'All public-site-changing actions go through propose_action — nothing goes live without approval.',
      defaultSkills: ['seo'],
      toolHints:
        'For each action: draft it (write_file or in-context), then call propose_action with the toolName, ' +
        'toolInput payload, proposedAction, detail, whyPriority. Once a human approves, the queue worker ' +
        'will execute. After execution, log_seo_action records what shipped.',
    },
    {
      type:          'seo_strategist',
      name:          'SEO Strategist',
      description:
        'High-level specialist used in weekly audits. Reviews cluster progress, competitor activity, ' +
        'metric trends, and identifies the top 3 leverage moves for the coming week. ' +
        'Output drives the weekly-audit report.',
      defaultSkills: ['seo'],
      toolHints:
        'Heavy use of query_metrics, query_clusters, query_opportunities, query_memory. ' +
        'Light use of web_search for competitor analysis. Output: 3-5 bullet TL;DR + state-of-play ' +
        'metrics + top 3 priorities + cluster status + risk flags.',
    },
  ],

  // ── Existing agent types preserved for backward compat ────────────────
  'seo-auditor': [
    {
      type:          'technical-auditor',
      name:          'Technical SEO Auditor',
      description:   'Crawls the site and checks all technical factors: Core Web Vitals, canonical tags, sitemap health, robots.txt, hreflang, structured data, redirect chains, broken links, duplicate content, mobile usability, page speed.',
      defaultSkills: ['seo-auditor', 'seo'],
      toolHints:     'Use web_fetch to examine page HTML and headers. Use run_command to call the PageSpeed Insights API. Use write_file to record findings. Work through one check at a time.',
    },
    {
      type:          'keyword-researcher',
      name:          'Keyword Researcher',
      description:   'Analyses Search Console data for ranking positions, CTR anomalies, impression share, quick-win opportunities (positions 5-15 with high impressions), keyword gaps versus competitors, and topic clustering.',
      defaultSkills: ['seo-auditor', 'seo'],
      toolHints:     'Use run_command to query Search Console and Ahrefs/SEMrush APIs. Use web_search to research keyword volumes. Use write_file to document keyword opportunities in structured JSON.',
    },
    {
      type:          'content-auditor',
      name:          'Content Auditor',
      description:   'Reviews all indexed pages for content quality: thin content, keyword alignment, title tag and meta description optimisation, internal linking gaps, content cannibalisation across similar pages.',
      defaultSkills: ['seo-auditor', 'seo'],
      toolHints:     'Use web_fetch to retrieve page content. Use run_command to enumerate indexed pages. Use write_file to score each page and record findings.',
    },
    {
      type:          'competitor-analyst',
      name:          'Competitor Analyst',
      description:   'Compares the target domain against competitor domains: domain authority trajectory, backlink profile quality, top-ranking pages by traffic, content gaps, keyword overlap and differentiation opportunities.',
      defaultSkills: ['seo-auditor', 'seo'],
      toolHints:     'Use web_search to research competitor rankings. Use web_fetch to examine competitor pages. Use run_command to call Ahrefs or SEMrush APIs. Use write_file to document the competitive landscape.',
    },
  ],

  'content-writer': [
    {
      type:          'researcher',
      name:          'Content Researcher',
      description:   'Researches the topic thoroughly: SERP landscape, competitor content depth, search intent, key points to cover, audience questions, topical authority gaps.',
      defaultSkills: ['content-writer'],
      toolHints:     'Use web_search extensively. Use web_fetch to read top-ranking pages. Use write_file to document research findings in structured form for the writer to use.',
    },
    {
      type:          'writer',
      name:          'Content Writer',
      description:   'Writes the actual content based on research: headlines, body copy, CTAs, following brand voice guidelines precisely.',
      defaultSkills: ['content-writer'],
      toolHints:     'Use read_file to load the researcher output. Use write_file to draft content. Do not publish — write to file only.',
    },
    {
      type:          'editor',
      name:          'Content Editor & SEO Optimiser',
      description:   'Reviews and optimises the draft: keyword placement, readability score, title and meta optimisation, internal linking suggestions, fact-checking, brand voice compliance.',
      defaultSkills: ['content-writer'],
      toolHints:     'Use read_file to load the draft. Use web_search to verify facts. Use write_file to save the final edited version.',
    },
  ],

  'data-analyst': [
    {
      type:          'data-collector',
      name:          'Data Collector',
      description:   'Pulls and cleans data from all configured sources: GA4, Search Console, ad platforms. Normalises date ranges and segments.',
      defaultSkills: ['data-analyst'],
      toolHints:     'Use run_command to call APIs. Use write_file to save raw and cleaned datasets in JSON or CSV.',
    },
    {
      type:          'analyst',
      name:          'Data Analyst',
      description:   'Analyses cleaned data: trends, anomalies, segment comparisons, attribution, correlation between metrics.',
      defaultSkills: ['data-analyst'],
      toolHints:     'Use read_file to load datasets. Use run_command to run analysis scripts. Use write_file to record findings and insights.',
    },
    {
      type:          'report-writer',
      name:          'Report Writer',
      description:   'Synthesises analytical findings into a structured, actionable client report with clear recommendations.',
      defaultSkills: ['data-analyst'],
      toolHints:     'Use read_file to load all analyst output. Use write_file to produce the formatted report.',
    },
  ],

  'researcher': [
    {
      type:          'primary-researcher',
      name:          'Primary Researcher',
      description:   'Conducts in-depth research across web sources, compiles evidence, and identifies key themes.',
      defaultSkills: [],
      toolHints:     'Use web_search and web_fetch extensively. Use write_file to structure findings.',
    },
    {
      type:          'synthesiser',
      name:          'Research Synthesiser',
      description:   'Reviews all primary research and synthesises it into a coherent structured output.',
      defaultSkills: [],
      toolHints:     'Use read_file to load research. Use write_file to produce the synthesis.',
    },
  ],

  'general': [
    {
      type:          'executor',
      name:          'Task Executor',
      description:   'Executes the task using all available tools.',
      defaultSkills: [],
      toolHints:     'Use all available tools as appropriate for the task.',
    },
  ],
}

export function getSpecialists(agentType: string): SpecialistDef[] {
  return SPECIALIST_REGISTRY[agentType] ?? SPECIALIST_REGISTRY['general']
}
