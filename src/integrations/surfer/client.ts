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
