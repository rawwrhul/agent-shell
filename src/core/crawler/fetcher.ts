// src/core/crawler/fetcher.ts
//
// Polite HTTP fetcher used by the crawler. Three responsibilities:
//
//   1. Bounded fetch — timeout, single retry on transient failures, never
//      hangs forever. Distinct from the unbounded `fetch()` in analyze_page
//      (which is fine for one-off invocations from a model but unacceptable
//      inside a 500-page BFS).
//
//   2. Throttling — per-host sleep between requests so we don't hammer a
//      tenant's site. Default 500ms; configurable via CrawlConfig.throttleMs.
//      The crawler invokes fetchPolite() sequentially per host, so a simple
//      sleep-before-return pattern suffices.
//
//   3. Content-type gating — only returns body for text/html (and a few
//      tolerated variants). Non-HTML responses come back with body=null and
//      a populated contentType, so the crawler still records the row but
//      skips parsing.
//
// What this file deliberately doesn't do:
//   - Robots.txt check. That's robots.ts. The crawler calls robots.isAllowed
//     before calling fetchPolite, so we keep concerns separate.
//   - Concurrency. The crawler is single-threaded per host; if/when we
//     parallelize across hosts (e.g. SEO-4 competitor crawls), that
//     orchestration lives in crawler.ts not here.

import { logger } from '../../logger'
import type { FetchResult } from './types'

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml']

const RETRY_BASE_DELAY_MS = 750
const MAX_RETRIES = 1   // total attempts = MAX_RETRIES + 1

export interface FetchPoliteOptions {
  /** Per-request timeout in ms. */
  timeoutMs:  number
  /** User-Agent header. */
  userAgent:  string
  /** Throttle delay applied AFTER the response returns (so the next call
   *  in the same loop iteration is naturally spaced). Default 500ms. */
  throttleMs: number
}

/**
 * Fetch a URL politely. Returns a FetchResult; never throws unless the
 * caller passed something fundamentally broken (e.g. malformed URL — which
 * the crawler validates upstream anyway).
 *
 * After the call resolves, sleeps `throttleMs` before returning so the
 * caller naturally throttles between requests without bookkeeping its own
 * sleep timer.
 */
export async function fetchPolite(
  url: string,
  opts: FetchPoliteOptions,
): Promise<FetchResult> {
  const t0 = Date.now()
  let lastError: string | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)

    try {
      const res = await fetch(url, {
        method:   'GET',
        headers: {
          'User-Agent': opts.userAgent,
          'Accept':     'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
        signal:   controller.signal,
        redirect: 'follow',
      })

      const contentType = res.headers.get('content-type')
      const isHtml = contentType !== null && HTML_CONTENT_TYPES.some(
        (t) => contentType.toLowerCase().includes(t),
      )

      // 5xx → retry once if we have budget. 4xx → return as-is, the crawler
      // wants to know about 404s etc.
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        lastError = `http_${res.status}`
        // Drain body to free the connection.
        try { await res.text() } catch { /* ignore */ }
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1))
        continue
      }

      let body: string | null = null
      if (isHtml) {
        try {
          body = await res.text()
        } catch (err) {
          // Body read failed even though headers came back. Treat as a
          // soft fetch failure; we still record status + final URL.
          logger.warn('crawler_body_read_failed', {
            url, err: String(err).slice(0, 200),
          })
        }
      } else {
        // Drain non-HTML responses so the socket can be reused.
        try { await res.text() } catch { /* ignore */ }
      }

      const elapsed = Date.now() - t0
      await sleep(opts.throttleMs)

      return {
        url,
        finalUrl:      res.url,
        status:        res.status,
        contentType,
        body,
        elapsedMs:     elapsed,
        error:         null,
        robotsBlocked: false,
      }
    } catch (err) {
      lastError = errorMessage(err)
      // Retry on network-y errors if budget remains.
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1))
        continue
      }
      // Final failure — emit a FetchResult with error set rather than
      // throwing. The crawler decides whether this kills the run.
      const elapsed = Date.now() - t0
      await sleep(opts.throttleMs)
      return {
        url,
        finalUrl:      url,
        status:        0,
        contentType:   null,
        body:          null,
        elapsedMs:     elapsed,
        error:         lastError,
        robotsBlocked: false,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // Unreachable given the loop structure, but TypeScript wants a return.
  const elapsed = Date.now() - t0
  return {
    url,
    finalUrl:      url,
    status:        0,
    contentType:   null,
    body:          null,
    elapsedMs:     elapsed,
    error:         lastError ?? 'exhausted_retries',
    robotsBlocked: false,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // AbortError → distinguish timeout from network failure for the caller.
    if (err.name === 'AbortError') return 'timeout'
    return err.message.slice(0, 200)
  }
  return String(err).slice(0, 200)
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const m = err.message.toLowerCase()
  // Conservative list — only retry things that are almost always transient.
  return (
    err.name === 'AbortError' ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('enotfound') ||      // DNS hiccup
    m.includes('socket hang up') ||
    m.includes('network')
  )
}
