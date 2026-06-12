import { pool } from './postgres'
import { config } from '../config'
import { logger } from '../logger'

// Voyage AI embeddings (voyage-4-lite @ 1024 dims, cosine).
//
// Graceful degradation: if VOYAGE_API_KEY is unset, storeLearning skips the
// write and retrieveRelevant returns [] — both with a warning. This is
// strictly better than the old all-zeros placeholder, which made every
// vector identical and injected arbitrary rows into prompts at
// similarity 1.0.
//
// input_type matters: 'document' when storing, 'query' when retrieving —
// Voyage prepends retrieval-tuned prompts per type and the embeddings
// remain mutually compatible.

const VOYAGE_MODEL = 'voyage-4-lite'
const VOYAGE_DIMS  = 1024
const VOYAGE_URL   = 'https://api.voyageai.com/v1/embeddings'

let warnedMissingKey = false

async function embed(text: string, inputType: 'document' | 'query'): Promise<number[] | null> {
  if (!config.VOYAGE_API_KEY) {
    if (!warnedMissingKey) {
      logger.warn('voyage_api_key_missing', {
        hint: 'Semantic memory disabled: storeLearning skips, retrieveRelevant returns []. Set VOYAGE_API_KEY to enable.',
      })
      warnedMissingKey = true
    }
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(VOYAGE_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model:            VOYAGE_MODEL,
        input:            [text],
        input_type:       inputType,
        output_dimension: VOYAGE_DIMS,
        truncation:       true,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.error('voyage_embed_failed', { status: res.status, body: body.slice(0, 300) })
      return null
    }
    const json = await res.json() as { data?: Array<{ embedding?: number[] }> }
    const vec = json.data?.[0]?.embedding
    if (!Array.isArray(vec) || vec.length !== VOYAGE_DIMS) {
      logger.error('voyage_embed_bad_shape', { got: Array.isArray(vec) ? vec.length : typeof vec })
      return null
    }
    return vec
  } catch (err) {
    logger.error('voyage_embed_error', { err: String(err).slice(0, 300) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function storeLearning(p: { tenantId: string; agentType: string; content: string; metadata?: Record<string,unknown> }) {
  const embedding = await embed(p.content, 'document')
  if (!embedding) {
    logger.warn('learning_store_skipped_no_embedding', { tenantId: p.tenantId, agentType: p.agentType })
    return
  }
  await pool.query(
    `INSERT INTO agent_learnings (tenant_id, agent_type, content, embedding, metadata, created_at)
     VALUES ($1,$2,$3,$4::vector,$5,NOW())`,
    [p.tenantId, p.agentType, p.content, `[${embedding.join(',')}]`, JSON.stringify(p.metadata ?? {})]
  )
}

export async function retrieveRelevant(p: { tenantId: string; agentType: string; query: string; topK?: number }) {
  // Best-effort by design: memory retrieval failing must never fail the
  // run that asked for it. Callers get [] on any error.
  try {
    const embedding = await embed(p.query, 'query')
    if (!embedding) return []
    const vec = `[${embedding.join(',')}]`
    const res = await pool.query(
      `SELECT content, metadata, 1-(embedding<=>$1::vector) as similarity
       FROM agent_learnings
       WHERE tenant_id=$2 AND agent_type=$3 AND embedding IS NOT NULL
       ORDER BY embedding<=>$1::vector LIMIT $4`,
      [vec, p.tenantId, p.agentType, p.topK ?? 5]
    )
    return res.rows as Array<{ content: string; metadata: Record<string,unknown>; similarity: number }>
  } catch (err) {
    logger.warn('learning_retrieve_failed', { tenantId: p.tenantId, agentType: p.agentType, err: String(err).slice(0, 300) })
    return []
  }
}
