// src/skills/seo-technical-auditor/types.ts
//
// Shared types for the audit module. Imported by every check, the delta
// pass, the synthesis layer, and the store.

export type Severity = 'P0' | 'P1' | 'P2' | 'P3'
export type FindingState = 'new' | 'persistent' | 'resolved' | 'ignored'
export type AuditStatus = 'in_progress' | 'completed' | 'failed'

/** What a check produces. Stable across runs via finding_key. */
export interface RawFinding {
  /** Identifies the check. Used to filter findings by type. */
  checkName:   string
  /** Stable identity across audits. Format: `<check_name>::<target>::<related>`
   *  where missing parts are empty strings. Used as the dedup key. */
  findingKey:  string
  /** Page the finding is "about". Usually the source page that has the issue. */
  targetUrl:   string | null
  /** Related URL — broken target, conflicting canonical, duplicate sibling, etc. */
  relatedUrl:  string | null
  severity:    Severity
  /** Free-form payload that gets stored as JSONB on the finding. The synthesis
   *  layer reads this to produce human-readable opportunity descriptions. */
  detail:      Record<string, unknown>
}

/** A finding after the delta pass — knows its state and history. */
export interface ResolvedFinding extends RawFinding {
  id:           string
  state:        FindingState
  firstSeenAt:  Date
  lastSeenAt:   Date
  weeksOpen:    number
}

/** Inputs available to every check function. Built once per audit. */
export interface CheckContext {
  tenantId:           string
  /** All inventory rows for the tenant from the latest crawl. */
  pages:              PageInventory[]
  /** All internal-link edges from the latest crawl, AFTER the nav heuristic
   *  has been applied (so `isNav` reflects both semantic-HTML and >50% rules). */
  links:              InternalLink[]
  /** Set of URLs that appear in the tenant's sitemap.xml. Empty set if the
   *  sitemap couldn't be fetched (logged elsewhere; not an audit failure). */
  sitemapUrls:        Set<string>
  /** Excluded URLs that should never become orphan / sitemap-inconsistency
   *  findings (e.g. /sitemap.xml itself, /robots.txt). */
  excludeFromOrphans: Set<string>
}

/** A check function. Pure: takes context, returns findings. No I/O, no
 *  exceptions on bad data (returns empty findings array instead). */
export type Check = (ctx: CheckContext) => RawFinding[] | Promise<RawFinding[]>

/** Slim view of seo_page_inventory used inside checks. */
export interface PageInventory {
  url:                string
  finalUrl:           string | null
  httpStatus:         number | null
  title:              string | null
  metaDescription:    string | null
  canonicalUrl:       string | null
  metaRobots:         string | null
  h1Count:            number
  h1First:            string | null
  schemaTypes:        string[]
  ogImage:            string | null
  language:           string | null
  wordCount:          number | null
  internalLinksOut:   number
  externalLinksOut:   number
  imageCount:         number
  imagesWithAlt:      number
  imagesMissingAlt:   number
  lastCrawledAt:      Date
  fetchError:         string | null
}

/** Slim view of seo_internal_links used inside checks. */
export interface InternalLink {
  sourceUrl:    string
  targetUrl:    string
  anchorText:   string
  rel:          string | null
  isNav:        boolean       // includes >50%-rule reclassification
  positionIndex: number
}

/** Output of a completed audit cycle, used for both DB record + L2 narrative. */
export interface AuditSummary {
  auditRunId:           string
  tenantId:             string
  status:               AuditStatus
  startedAt:            Date
  completedAt:          Date
  durationMs:           number
  findingsTotal:        number
  findingsNew:          number
  findingsPersistent:   number
  findingsResolved:     number
  opportunitiesCreated: number
  /** Severity histogram across the *current* (new + persistent) findings. */
  severityCounts:       Record<Severity, number>
  /** Single-line narrative produced by the synthesis layer. Goes to
   *  tenant_memory key 'audit-summary'. */
  narrative:            string
  error:                string | null
}
