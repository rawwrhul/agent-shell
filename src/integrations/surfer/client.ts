// src/integrations/surfer/client.ts
//
// SurferSEO API. Auth: `API-Key` header from the CGS-shared
// `surfer_api_key` credential (Secret Manager: cgs-surfer-api-key).
//
// ⚠️ ACCESS: Surfer's API requires their Custom Plan or the API Add-on
// (contact Surfer to enable). Their endpoint docs sit behind that access,
// so this client is deliberately SHAPE-TOLERANT: requests follow Surfer's
// stable conventions (base URL, API-Key header, content-editor create →
// poll → read flow) and responses are passed through with defensive
// extraction. Finalize exact field mapping against real responses via
// `npm run vendor:check` once the key is live — the check prints raw
// response shapes for exactly this purpose.

import { getSharedCredential } from '../../credentials/resolver'
import { logger } from '../../logger'

const BASE = 'https://app.surferseo.com/api/v1'

let _key: string | null = null
async function apiKey(): Promise<string> {
  if (_key) return _key
  // Env override first — lets local scripts/smoke tests run without Secret
  // Manager access (some dev machines can't reach it from Node).
  if (process.env.SURFER_API_KEY) { _key = process.env.SURFER_API_KEY; return _key }
  const cred = await getSharedCredential('surfer_api_key')
  if (!cred) throw new Error('Surfer API key not configured. Run: npm run setup:cgs (surfer_api_key)')
  _key = cred
  return _key
}

export async function surferRequest(
  method: 'GET' | 'POST',
  path:   string,
  body?:  Record<string, unknown>,
): Promise<unknown> {
  const key = await apiKey()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'API-Key':      key,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      logger.warn('surfer_request_failed', { path, status: res.status, body: text.slice(0, 300) })
      throw new Error(`Surfer ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a Content Editor for a keyword and poll until its guidelines are
 * ready (Surfer scrapes the live SERP, which takes up to ~2 minutes).
 */
export async function createAndAwaitContentEditor(
  keyword:  string,
  location: string,
): Promise<unknown> {
  const created = await surferRequest('POST', '/content_editors', {
    keywords: [keyword],
    location,
  }) as Record<string, unknown>

  const id = (created.id ?? (created as { content_editor?: { id?: unknown } }).content_editor?.id) as string | number | undefined
  if (id === undefined) {
    // Shape drift — return whatever we got so the caller (and vendor:check)
    // can see the real structure.
    logger.warn('surfer_editor_id_not_found_in_response', { keys: Object.keys(created) })
    return created
  }

  const deadline = Date.now() + 150_000
  for (;;) {
    const editor = await surferRequest('GET', `/content_editors/${id}`) as Record<string, unknown>
    const state = String(editor.state ?? editor.status ?? '')
    if (state && !['queued', 'pending', 'in_progress', 'processing', 'scraping'].includes(state.toLowerCase())) {
      return editor
    }
    if (Date.now() > deadline) {
      logger.warn('surfer_editor_poll_timeout', { id, lastState: state })
      return editor
    }
    await new Promise(r => setTimeout(r, 10_000))
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  API v2 — verified against https://app.surferseo.com/llms.txt (2026-07-14)
//
//  v2 paths are WORKSPACE-SCOPED: /api/v2/workspaces/:ws/content_editors/…
//  The score loop: create editor (1 credit, async SERP analysis) → poll
//  state=completed → PUT raw HTML to …/content (Content-Type: text/html,
//  204) → score recalculates async → poll editor detail until
//  content_score is populated. Re-scoring new content on the SAME editor
//  is free — the revision pass costs no extra credit.
// ═════════════════════════════════════════════════════════════════════════

const BASE_V2 = 'https://app.surferseo.com/api/v2'

export async function surferV2(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path:   string,
  body?:  Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<unknown> {
  const key = await apiKey()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${BASE_V2}${path}`, {
      method,
      headers: {
        'API-Key':      key,
        'Content-Type': 'application/json',
        Accept:         'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      logger.warn('surfer_v2_request_failed', { path, status: res.status, body: text.slice(0, 300) })
      throw new Error(`Surfer v2 ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

/** PUT raw HTML content to an editor (v2 content route wants text/html, returns 204). */
async function surferV2PutContent(wsId: number, editorId: number, html: string): Promise<void> {
  const key = await apiKey()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${BASE_V2}/workspaces/${wsId}/content_editors/${editorId}/content`, {
      method: 'PUT',
      headers: { 'API-Key': key, 'Content-Type': 'text/html' },
      body: html,
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Surfer v2 PUT content → ${res.status}: ${text.slice(0, 300)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

let _wsId: number | null = null
export async function getWorkspaceId(): Promise<number> {
  if (_wsId !== null) return _wsId
  // Cheapest reliable source: the org-wide editor list embeds workspace_id.
  const res = await surferV2('GET', '/workspaces') as Record<string, unknown>
  const arr = (res.data ?? res.workspaces ?? []) as Array<Record<string, unknown>>
  const id = Number(arr[0]?.id)
  if (!Number.isFinite(id)) throw new Error(`Surfer v2: could not resolve workspace id (keys: ${Object.keys(res).join(',')})`)
  _wsId = id
  return id
}

export interface SurferV2Score {
  editorId:  number
  total:     number | null
  seo:       number | null
  aiSearch:  number | null
  editorUrl: string | null
}

function readScore(editor: Record<string, unknown>): { total: number | null; seo: number | null; aiSearch: number | null } {
  const cs = (editor.content_score ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { total: num(cs.total), seo: num(cs.seo), aiSearch: num(cs.ai_search) }
}

async function pollEditor(
  wsId: number, editorId: number,
  until: (e: Record<string, unknown>) => boolean,
  timeoutMs: number, intervalMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const editor = await surferV2('GET', `/workspaces/${wsId}/content_editors/${editorId}`) as Record<string, unknown>
    if (until(editor)) return editor
    if (Date.now() > deadline) return editor
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

interface SeoScoreState { status: string; score: number | null; calculatedAt: string | null }

/** GET the SEO score child endpoint: { status: "ready", score: 24, calculated_at: ISO }. */
async function getSeoScoreState(wsId: number, editorId: number): Promise<SeoScoreState> {
  try {
    const res = await surferV2('GET', `/workspaces/${wsId}/content_editors/${editorId}/seo_guidelines/score`) as Record<string, unknown>
    return {
      status:       String(res.status ?? ''),
      score:        typeof res.score === 'number' && Number.isFinite(res.score) ? res.score : null,
      calculatedAt: typeof res.calculated_at === 'string' ? res.calculated_at : null,
    }
  } catch {
    return { status: 'error', score: null, calculatedAt: null }
  }
}

/** Poll the score endpoint until a FRESH ready score lands (calculated_at
 *  advanced past prevCalculatedAt — the PUT itself doesn't settle the score,
 *  observed live: stale score readable during recalculation). */
async function pollSeoScore(
  wsId: number, editorId: number, prevCalculatedAt: string | null,
  timeoutMs: number, intervalMs: number,
): Promise<SeoScoreState> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = await getSeoScoreState(wsId, editorId)
    const fresh = s.calculatedAt !== null && s.calculatedAt !== prevCalculatedAt
    if (s.status === 'ready' && s.score !== null && fresh) return s
    if (Date.now() > deadline) {
      logger.warn('surfer_v2_score_poll_timeout', { editorId, lastStatus: s.status, fresh })
      return s
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

/** Create a v2 editor and wait for SERP analysis. ONE credit. Returns editor id. */
export async function createAndAwaitEditorV2(keyword: string, location: string): Promise<number> {
  const wsId = await getWorkspaceId()
  const created = await surferV2('POST', `/workspaces/${wsId}/content_editors`, {
    main_keyword:        keyword,
    location,
    use_brand_knowledge: false,
  }, { 'Idempotency-Key': `ce-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }) as Record<string, unknown>
  const editorId = Number(created.id)
  if (!Number.isFinite(editorId)) throw new Error(`Surfer v2: create returned no editor id (keys: ${Object.keys(created).join(',')})`)
  const ready = await pollEditor(wsId, editorId, e => String(e.state) === 'completed', 240_000, 10_000)
  if (String(ready.state) !== 'completed') {
    throw new Error(`Surfer v2: editor ${editorId} not completed after 4min (state=${ready.state})`)
  }
  return editorId
}

/**
 * Score content against a fresh Surfer editor for the keyword.
 * Costs ONE Content Editor credit. ~2-4 min end to end (SERP analysis).
 */
export async function scoreContentV2(args: {
  keyword:  string
  content:  string
  location: string
}): Promise<SurferV2Score> {
  const wsId = await getWorkspaceId()
  const editorId = await createAndAwaitEditorV2(args.keyword, args.location)

  // Snapshot score state, put our content, wait for a FRESH score.
  const pre = await getSeoScoreState(wsId, editorId)
  await surferV2PutContent(wsId, editorId, args.content)
  const settled = await pollSeoScore(wsId, editorId, pre.calculatedAt, 180_000, 6_000)

  const detail = await surferV2('GET', `/workspaces/${wsId}/content_editors/${editorId}`) as Record<string, unknown>
  const unified = readScore(detail)
  const permalinks = (detail.permalinks ?? []) as Array<Record<string, unknown>>
  return {
    editorId,
    total:    unified.total ?? settled.score,
    seo:      settled.score ?? unified.seo,
    aiSearch: unified.aiSearch,
    editorUrl: typeof permalinks[0]?.url === 'string' ? permalinks[0].url : null,
  }
}

/** Re-score new content on an existing editor. FREE — no new credit.
 *  Settles on the score endpoint's calculated_at advancing (the stale score
 *  stays readable during recalculation — observed live). */
export async function rescoreContentV2(editorId: number, content: string): Promise<SurferV2Score> {
  const wsId = await getWorkspaceId()
  const pre = await getSeoScoreState(wsId, editorId)
  await surferV2PutContent(wsId, editorId, content)
  const settled = await pollSeoScore(wsId, editorId, pre.calculatedAt, 180_000, 6_000)

  const detail = await surferV2('GET', `/workspaces/${wsId}/content_editors/${editorId}`) as Record<string, unknown>
  const unified = readScore(detail)
  const permalinks = (detail.permalinks ?? []) as Array<Record<string, unknown>>
  return {
    editorId,
    total:    unified.total ?? settled.score,
    seo:      settled.score ?? unified.seo,
    aiSearch: unified.aiSearch,
    editorUrl: typeof permalinks[0]?.url === 'string' ? permalinks[0].url : null,
  }
}

/** Read the editor's current content back (HTML). */
export async function getEditorContentV2(editorId: number): Promise<string> {
  const wsId = await getWorkspaceId()
  const key = await apiKey()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${BASE_V2}/workspaces/${wsId}/content_editors/${editorId}/content`, {
      headers: { 'API-Key': key, Accept: 'text/html' },
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Surfer v2 GET content → ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Auto-Optimize: Surfer rewrites the editor's content server-side to raise
 * its own content score, writing changes directly into the editor. Costs an
 * Auto-Optimize credit (402/quota error when out). We poll the SEO score's
 * calculated_at for settle (optimization triggers a recalc), then the
 * caller reads back the optimized content + fresh score.
 * Returns { ran, score }: ran=false when Surfer says nothing to optimize
 * (204); score is the fresh post-optimization SEO score when ran=true.
 */
export async function autoOptimizeV2(editorId: number): Promise<{ ran: boolean; score: number | null }> {
  const wsId = await getWorkspaceId()
  const pre = await getSeoScoreState(wsId, editorId)

  const key = await apiKey()
  const res = await fetch(`${BASE_V2}/workspaces/${wsId}/content_editors/${editorId}/auto_optimize`, {
    method: 'POST',
    headers: { 'API-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
  })
  if (res.status === 204) return { ran: false, score: pre.score }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Surfer v2 auto_optimize → ${res.status}: ${text.slice(0, 300)}`)
  }

  // Optimization is async and can take several minutes on long content.
  const settled = await pollSeoScore(wsId, editorId, pre.calculatedAt, 480_000, 15_000)
  if (settled.calculatedAt === pre.calculatedAt) {
    throw new Error(`Surfer v2 auto_optimize: score did not settle within 8min (editor ${editorId})`)
  }
  return { ran: true, score: settled.score }
}

/** SEO guidelines (terms + structure) from an editor — v2 child endpoints. */
export async function getGuidelinesV2(editorId: number): Promise<{ terms: unknown; structure: unknown }> {
  const wsId = await getWorkspaceId()
  const [terms, structure] = await Promise.all([
    surferV2('GET', `/workspaces/${wsId}/content_editors/${editorId}/seo_guidelines/terms`).catch(e => ({ error: String(e).slice(0, 200) })),
    surferV2('GET', `/workspaces/${wsId}/content_editors/${editorId}/seo_guidelines/structure`).catch(e => ({ error: String(e).slice(0, 200) })),
  ])
  return { terms, structure }
}
