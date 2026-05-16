// src/core/crawler/robots.ts
//
// Per-host robots.txt cache + isAllowed() check.
//
// Why a separate module: robots checks happen for every URL the crawler
// considers, including ones it ultimately skips. Caching per host (not
// per crawl) means a fresh crawl reuses the robots.txt fetched seconds
// ago by the previous crawl — that's a network round-trip and ~1ms of
// parse time saved per page visited.
//
// Lifetime: cache lives in-process and is bounded by Cloud Run instance
// lifetime (Cloud Run recycles on deploy / scale events). That's plenty
// for crawl cadence.

import robotsParser from 'robots-parser'
import { logger } from '../../logger'
import { fetchPolite } from './fetcher'

interface CachedRobots {
  /** robots-parser Robots instance, or null if robots.txt was missing /
   *  unparseable (treat as "everything allowed"). */
  parser:   ReturnType<typeof robotsParser> | null
  fetchedAt: number
}

// Per-host cache. Key = `${protocol}//${host}` for safety (HTTP and HTTPS
// of the same host can serve different robots.txt — rare but possible).
const cache = new Map<string, CachedRobots>()

const CACHE_TTL_MS = 6 * 60 * 60 * 1000  // 6h

/**
 * Check whether the configured user-agent is allowed to fetch `url`.
 *
 * Conservative defaults:
 *   - robots.txt fetch failure → assume allowed (don't punish the tenant
 *     for misconfiguring robots.txt by refusing to crawl).
 *   - robots.txt parse error → assume allowed.
 *   - 404 on robots.txt → standard behaviour: everything allowed.
 *
 * Aggressive only on: explicit Disallow matching the user-agent or *.
 */
export async function isAllowed(
  url: string,
  userAgent: string,
  opts: { fetchTimeoutMs: number } = { fetchTimeoutMs: 10_000 },
): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const key = `${parsed.protocol}//${parsed.host}`
  const cached = cache.get(key)

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    if (cached.parser === null) return true
    return cached.parser.isAllowed(url, userAgent) ?? true
  }

  // Fetch + cache.
  const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`
  let parser: ReturnType<typeof robotsParser> | null = null

  try {
    const res = await fetchPolite(robotsUrl, {
      timeoutMs:  opts.fetchTimeoutMs,
      userAgent,
      throttleMs: 0,  // robots.txt fetches don't count toward crawl politeness budget
    })

    if (res.status === 200 && res.body !== null) {
      parser = robotsParser(robotsUrl, res.body)
    } else {
      // 404, 403, network failure, etc. — treat as "no robots.txt" (allow all).
      logger.info('crawler_robots_unavailable', {
        host: parsed.host, status: res.status, error: res.error,
      })
    }
  } catch (err) {
    logger.warn('crawler_robots_fetch_threw', {
      host: parsed.host, err: String(err).slice(0, 200),
    })
  }

  cache.set(key, { parser, fetchedAt: Date.now() })

  if (parser === null) return true
  return parser.isAllowed(url, userAgent) ?? true
}

/**
 * Get crawl-delay (in seconds) declared in robots.txt for the configured
 * user-agent. Returns null if not declared. Crawler can respect this by
 * raising throttleMs for the affected host.
 */
export async function getCrawlDelay(
  url: string,
  userAgent: string,
): Promise<number | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const key = `${parsed.protocol}//${parsed.host}`
  const cached = cache.get(key)

  if (cached?.parser) {
    const delay = cached.parser.getCrawlDelay(userAgent)
    return delay ?? null
  }

  // If not in cache, populate it via isAllowed first, then re-read.
  // We don't care about the result here, just want the parser cached.
  await isAllowed(url, userAgent)
  return cache.get(key)?.parser?.getCrawlDelay(userAgent) ?? null
}

/**
 * Clear the in-process cache. Useful in tests and after manually editing
 * a tenant's robots.txt.
 */
export function resetRobotsCache(): void {
  cache.clear()
}
