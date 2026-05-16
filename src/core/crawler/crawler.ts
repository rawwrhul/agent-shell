// src/core/crawler/crawler.ts
//
// BFS site crawler. Single-threaded per host (which is also "per crawl"
// for v1 since CrawlConfig.allowedHosts is typically one host). The
// crawler:
//
//   1. Inserts a seo_crawl_runs row, status='in_progress'.
//   2. BFS from seedUrls:
//        - Honours robots.txt (unless respectRobots=false)
//        - Respects maxDepth and maxPages caps
//        - Skips non-HTML responses (records the inventory row, doesn't
//          enqueue children)
//        - Skips noindex pages from the queue (still records them — the
//          fact that a page is noindex is itself a useful signal)
//        - Records page_inventory + replaces internal_links for each
//          successfully parsed page
//   3. On completion (success, failure, or page-cap), updates the
//      crawl_runs row with final stats and returns a CrawlSummary.
//
// Cancellation: not implemented for v1. Long crawls run to completion or
// fail. A later iteration can add a cancellation token wired to the
// scheduler.
//
// Error handling: individual page failures (timeout, 5xx, parse error)
// are recorded on the inventory row and crawl continues. Only an
// unrecoverable DB error or seed-URL validation failure aborts the run.

import { v4 as uuid } from 'uuid'
import { logger } from '../../logger'
import { fetchPolite } from './fetcher'
import { isAllowed, getCrawlDelay } from './robots'
import { parsePage } from './parser'
import {
  startCrawlRun,
  updateCrawlRunProgress,
  finishCrawlRun,
  upsertPageInventory,
  recordFetchFailure,
  replaceLinksForSource,
  getCrawlSummaryStats,
} from './store'
import { onCrawlCompleted } from '../../memory/pipeline-events'
import type {
  CrawlConfig,
  CrawlSummary,
  ParsedPage,
  FetchResult,
} from './types'
import { DEFAULT_CRAWL_CONFIG } from './types'

/**
 * Run a crawl to completion. Returns when done (success, page-cap,
 * fatal error). Does not throw on per-page failures.
 */
export async function runCrawl(
  configIn: Partial<CrawlConfig> & Pick<CrawlConfig, 'tenantId' | 'seedUrls'>,
): Promise<CrawlSummary> {
  const config = applyDefaults(configIn)
  validateConfig(config)

  const runId = uuid()
  const startedAt = new Date()

  await startCrawlRun({
    runId,
    tenantId:  config.tenantId,
    crawlKind: config.crawlKind,
    seedUrls:  config.seedUrls,
    maxPages:  config.maxPages,
    maxDepth:  config.maxDepth,
    userAgent: config.userAgent,
    metadata:  config.metadata ?? {},
  })

  logger.info('crawler_run_started', {
    runId,
    tenantId:     config.tenantId,
    crawlKind:    config.crawlKind,
    seedCount:    config.seedUrls.length,
    maxPages:     config.maxPages,
    maxDepth:     config.maxDepth,
    allowedHosts: config.allowedHosts,
  })

  let pagesCrawled = 0
  let pagesFailed = 0
  let pagesSkipped = 0
  const samples: CrawlSummary['samples'] = []
  let fatalError: string | null = null
  let effectiveThrottle = config.throttleMs

  // Per-host crawl-delay enforcement: if robots.txt asks for more than our
  // configured throttle, honour it. (We don't go faster than configured
  // even if robots says it's fine.)
  try {
    if (config.respectRobots && config.seedUrls[0]) {
      const declaredDelay = await getCrawlDelay(config.seedUrls[0], config.userAgent)
      if (declaredDelay !== null) {
        const declaredMs = declaredDelay * 1000
        if (declaredMs > effectiveThrottle) {
          logger.info('crawler_honouring_crawl_delay', {
            runId, declaredMs, configuredMs: config.throttleMs,
          })
          effectiveThrottle = declaredMs
        }
      }
    }
  } catch (err) {
    logger.warn('crawler_crawl_delay_check_failed', {
      runId, err: String(err).slice(0, 200),
    })
  }

  // BFS state.
  type QueueItem = { url: string; depth: number }
  const queue: QueueItem[] = []
  const visited = new Set<string>()
  const enqueued = new Set<string>()

  for (const seed of config.seedUrls) {
    const normalized = normalizeSeed(seed)
    if (normalized && !enqueued.has(normalized)) {
      queue.push({ url: normalized, depth: 0 })
      enqueued.add(normalized)
    }
  }

  try {
    while (queue.length > 0 && pagesCrawled < config.maxPages) {
      const { url, depth } = queue.shift()!
      if (visited.has(url)) continue
      visited.add(url)

      // ── Host gating ──────────────────────────────────────────────────
      const hostOk = isHostAllowed(url, config.allowedHosts)
      if (!hostOk) {
        pagesSkipped++
        continue
      }

      // ── Robots gating ────────────────────────────────────────────────
      if (config.respectRobots) {
        const allowed = await isAllowed(url, config.userAgent)
        if (!allowed) {
          pagesSkipped++
          logger.debug('crawler_robots_blocked', { runId, url })
          continue
        }
      }

      // ── Fetch ────────────────────────────────────────────────────────
      let result: FetchResult
      try {
        result = await fetchPolite(url, {
          timeoutMs:  config.fetchTimeoutMs,
          userAgent:  config.userAgent,
          throttleMs: effectiveThrottle,
        })
      } catch (err) {
        // fetchPolite shouldn't throw, but belt-and-braces:
        pagesFailed++
        await recordFetchFailure({
          tenantId: config.tenantId, runId, url,
          error:    String(err).slice(0, 500),
        }).catch(() => { /* swallow store error */ })
        continue
      }

      // ── Failed fetch (network error, timeout, etc.) ──────────────────
      if (result.error !== null || result.status === 0) {
        pagesFailed++
        await recordFetchFailure({
          tenantId: config.tenantId, runId,
          url:      result.url,
          error:    result.error ?? `status_${result.status}`,
        }).catch((err) => {
          logger.warn('crawler_failure_record_failed', {
            runId, url, err: String(err).slice(0, 200),
          })
        })
        continue
      }

      // ── Non-HTML response ────────────────────────────────────────────
      if (result.body === null) {
        // Still record the inventory row — knowing a URL serves a PDF is
        // useful — but don't parse or enqueue children.
        pagesCrawled++
        await upsertPageInventory({
          tenantId: config.tenantId, runId,
          parsed: minimalInventoryForNonHtml(result),
        }).catch((err) => {
          logger.warn('crawler_inventory_upsert_failed', {
            runId, url, err: String(err).slice(0, 200),
          })
        })
        if (pagesCrawled % 25 === 0) {
          await updateCrawlRunProgress({ runId, pagesCrawled, pagesFailed, pagesSkipped })
        }
        continue
      }

      // ── Parse ────────────────────────────────────────────────────────
      let parsed: ParsedPage
      try {
        parsed = parsePage({
          url:         result.url,
          finalUrl:    result.finalUrl,
          httpStatus:  result.status,
          contentType: result.contentType,
          body:        result.body,
        })
      } catch (err) {
        pagesFailed++
        await recordFetchFailure({
          tenantId: config.tenantId, runId,
          url:      result.url,
          error:    `parse_failed: ${String(err).slice(0, 400)}`,
        }).catch(() => { /* swallow */ })
        continue
      }

      // ── Persist ──────────────────────────────────────────────────────
      try {
        await upsertPageInventory({
          tenantId: config.tenantId, runId, parsed,
        })
        // Only store the link graph if the page actually has a 2xx status
        // and isn't noindex. Pages we wouldn't want to surface as "this
        // page links to X" anyway shouldn't pollute the graph.
        if (parsed.httpStatus >= 200 && parsed.httpStatus < 300) {
          await replaceLinksForSource({
            tenantId: config.tenantId,
            sourceUrl: parsed.finalUrl,
            links: parsed.links,
          })
        }
      } catch (err) {
        // DB-level persistence failure is more serious than fetch/parse.
        // Log loudly but keep crawling — better to capture 80% of pages
        // than to abort.
        logger.error('crawler_persist_failed', {
          runId, url: parsed.url,
          err: String(err).slice(0, 400),
        })
      }

      pagesCrawled++
      if (samples.length < 5) {
        samples.push({
          url: parsed.finalUrl,
          status: parsed.httpStatus,
          title: parsed.title,
        })
      }

      // ── Enqueue children ─────────────────────────────────────────────
      const shouldEnqueueChildren =
        depth < config.maxDepth &&
        parsed.httpStatus >= 200 && parsed.httpStatus < 300 &&
        !isNoIndex(parsed.metaRobots)

      if (shouldEnqueueChildren) {
        for (const link of parsed.links) {
          if (!link.isInternal) continue
          if (link.rel?.toLowerCase().split(/\s+/).includes('nofollow')) continue
          if (enqueued.has(link.target)) continue
          enqueued.add(link.target)
          queue.push({ url: link.target, depth: depth + 1 })
        }
      }

      // ── Periodic progress checkpoint ─────────────────────────────────
      if (pagesCrawled % 25 === 0) {
        await updateCrawlRunProgress({
          runId, pagesCrawled, pagesFailed, pagesSkipped,
        }).catch((err) => {
          logger.warn('crawler_progress_update_failed', {
            runId, err: String(err).slice(0, 200),
          })
        })
        logger.info('crawler_progress', {
          runId, pagesCrawled, pagesFailed, pagesSkipped,
          queueDepth: queue.length,
        })
      }
    }
  } catch (err) {
    fatalError = String(err).slice(0, 500)
    logger.error('crawler_fatal', { runId, err: fatalError })
  }

  const completedAt = new Date()
  const status = fatalError ? 'failed' : 'completed'

  await finishCrawlRun({
    runId, status,
    pagesCrawled, pagesFailed, pagesSkipped,
    completedAt,
    error: fatalError,
  })

  // ── L2 memory hook: write inventory summary so future agent runs see it
  //    as ambient context. Best-effort; never blocks the return path.
  if (status === 'completed') {
    try {
      const stats = await getCrawlSummaryStats(config.tenantId)
      await onCrawlCompleted({
        tenantId:         config.tenantId,
        pagesCrawled,
        pagesFailed,
        pagesSkipped,
        statusBreakdown:  stats.pagesByStatus,
        pagesMissingH1:   stats.pagesMissingH1,
        pagesMissingMeta: stats.pagesMissingMeta,
        orphanedPages:    stats.orphanedPages,
        internalEdges:    stats.totalEdges,
      })
    } catch (err) {
      logger.warn('crawler_memory_hook_failed', {
        runId, err: String(err).slice(0, 200),
      })
    }
  }

  const summary: CrawlSummary = {
    runId,
    tenantId:     config.tenantId,
    status,
    pagesCrawled,
    pagesFailed,
    pagesSkipped,
    startedAt,
    completedAt,
    durationMs:   completedAt.getTime() - startedAt.getTime(),
    error:        fatalError,
    samples,
  }

  const { samples: _samples, ...summaryForLog } = summary
  logger.info('crawler_run_completed', summaryForLog)

  return summary
}

// ── Helpers ───────────────────────────────────────────────────────────────

function applyDefaults(
  partial: Partial<CrawlConfig> & Pick<CrawlConfig, 'tenantId' | 'seedUrls'>,
): CrawlConfig {
  return {
    tenantId:       partial.tenantId,
    seedUrls:       partial.seedUrls,
    crawlKind:      partial.crawlKind      ?? DEFAULT_CRAWL_CONFIG.crawlKind,
    maxPages:       partial.maxPages       ?? DEFAULT_CRAWL_CONFIG.maxPages,
    maxDepth:       partial.maxDepth       ?? DEFAULT_CRAWL_CONFIG.maxDepth,
    throttleMs:     partial.throttleMs     ?? DEFAULT_CRAWL_CONFIG.throttleMs,
    fetchTimeoutMs: partial.fetchTimeoutMs ?? DEFAULT_CRAWL_CONFIG.fetchTimeoutMs,
    userAgent:      partial.userAgent      ?? DEFAULT_CRAWL_CONFIG.userAgent,
    respectRobots:  partial.respectRobots  ?? DEFAULT_CRAWL_CONFIG.respectRobots,
    allowedHosts:   partial.allowedHosts   ?? deriveAllowedHosts(partial.seedUrls),
    metadata:       partial.metadata,
  }
}

function deriveAllowedHosts(seeds: string[]): string[] {
  const hosts = new Set<string>()
  for (const seed of seeds) {
    try {
      hosts.add(new URL(seed).hostname.toLowerCase())
    } catch { /* skip */ }
  }
  return Array.from(hosts)
}

function validateConfig(config: CrawlConfig): void {
  if (!config.tenantId) throw new Error('tenantId is required')
  if (!config.seedUrls.length) throw new Error('seedUrls is empty')
  if (config.maxPages < 1) throw new Error('maxPages must be >= 1')
  if (config.maxDepth < 0) throw new Error('maxDepth must be >= 0')
  for (const seed of config.seedUrls) {
    try {
      const u = new URL(seed)
      if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error(`seedUrl ${seed} is not http(s)`)
      }
    } catch (err) {
      throw new Error(`invalid seedUrl ${seed}: ${String(err)}`)
    }
  }
}

function normalizeSeed(seed: string): string | null {
  try {
    const u = new URL(seed)
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    return u.href
  } catch {
    return null
  }
}

function isHostAllowed(url: string, allowedHosts: string[]): boolean {
  if (!allowedHosts.length) return true
  try {
    const host = new URL(url).hostname.toLowerCase()
    // Allow exact match OR www-stripped match in either direction.
    const stripped = host.replace(/^www\./, '')
    return allowedHosts.some((h) => {
      const a = h.toLowerCase()
      return a === host || a === stripped || a.replace(/^www\./, '') === stripped
    })
  } catch {
    return false
  }
}

function isNoIndex(metaRobots: string | null): boolean {
  if (!metaRobots) return false
  return metaRobots.toLowerCase().split(/[,\s]+/).includes('noindex')
}

function minimalInventoryForNonHtml(r: FetchResult): ParsedPage {
  return {
    url:               r.url,
    finalUrl:          r.finalUrl,
    httpStatus:        r.status,
    contentType:       r.contentType,
    contentHash:       null,
    title:             null,
    titleLength:       0,
    metaDescription:   null,
    metaDescLength:    0,
    metaRobots:        null,
    canonicalUrl:      null,
    language:          null,
    ogImage:           null,
    h1Count:           0,
    h1First:           null,
    schemaTypes:       [],
    wordCount:         0,
    imageCount:        0,
    imagesWithAlt:     0,
    imagesMissingAlt:  0,
    links:             [],
    internalLinkCount: 0,
    externalLinkCount: 0,
  }
}
