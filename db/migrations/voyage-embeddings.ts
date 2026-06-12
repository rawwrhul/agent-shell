// db/migrations/voyage-embeddings.ts
//
// Migrate agent_learnings.embedding from vector(1536) — sized for the old
// all-zeros placeholder — to vector(1024) for Voyage voyage-4-lite.
//
// Existing embeddings are all zero vectors (the placeholder never produced
// anything else), so dropping the column loses nothing. Idempotent: checks
// the current dimension via atttypmod and only migrates when it isn't 1024.

import { Pool } from 'pg'

export async function runVoyageEmbeddingsMigration(pool: Pool): Promise<void> {
  const res = await pool.query(
    `SELECT atttypmod AS dims
     FROM pg_attribute
     WHERE attrelid = 'agent_learnings'::regclass
       AND attname  = 'embedding'
       AND NOT attisdropped`
  )

  const dims = res.rows[0]?.dims as number | undefined
  if (dims === 1024) {
    console.log('  voyage-embeddings: already vector(1024), skipping')
    return
  }

  console.log(`  voyage-embeddings: migrating embedding column vector(${dims ?? '?'}) → vector(1024)`)
  await pool.query(`DROP INDEX IF EXISTS idx_learn_vec`)
  await pool.query(`ALTER TABLE agent_learnings DROP COLUMN IF EXISTS embedding`)
  await pool.query(`ALTER TABLE agent_learnings ADD COLUMN embedding vector(1024)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_learn_vec
    ON agent_learnings USING ivfflat (embedding vector_cosine_ops) WITH (lists=100)`)
  console.log('  voyage-embeddings: done')
}
