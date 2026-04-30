import { pool } from './postgres'
import { config } from '../config'
import { logger } from '../logger'

// Placeholder embedding — swap for Voyage API in production:
// POST https://api.voyageai.com/v1/embeddings
async function embed(_text: string): Promise<number[]> {
  logger.warn('placeholder_embedding_in_use — replace with Voyage API for production')
  return new Array(1536).fill(0)
}

export async function storeLearning(p: { tenantId: string; agentType: string; content: string; metadata?: Record<string,unknown> }) {
  const embedding = await embed(p.content)
  await pool.query(
    `INSERT INTO agent_learnings (tenant_id, agent_type, content, embedding, metadata, created_at)
     VALUES ($1,$2,$3,$4::vector,$5,NOW())`,
    [p.tenantId, p.agentType, p.content, `[${embedding.join(',')}]`, JSON.stringify(p.metadata ?? {})]
  )
}

export async function retrieveRelevant(p: { tenantId: string; agentType: string; query: string; topK?: number }) {
  const embedding = await embed(p.query)
  const vec = `[${embedding.join(',')}]`
  const res = await pool.query(
    `SELECT content, metadata, 1-(embedding<=>$1::vector) as similarity
     FROM agent_learnings WHERE tenant_id=$2 AND agent_type=$3
     ORDER BY embedding<=>$1::vector LIMIT $4`,
    [vec, p.tenantId, p.agentType, p.topK ?? 5]
  )
  return res.rows as Array<{ content: string; metadata: Record<string,unknown>; similarity: number }>
}
