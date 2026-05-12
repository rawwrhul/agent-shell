// src/integrations/storage.ts
//
// Encrypted credential storage for per-tenant API keys.
//
// Algorithm: AES-256-GCM (authenticated encryption — detects tampering)
// Format: [12-byte IV][16-byte auth tag][N-byte ciphertext], stored as bytea.
// Key: 32 bytes base64-encoded, read from CREDENTIAL_ENCRYPTION_KEY env var.
//
// To generate a key:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Rotate by:
//   1) generate new key, set it as CREDENTIAL_ENCRYPTION_KEY_NEW
//   2) read every row with the old key, re-encrypt with the new key, write back
//   3) swap env vars: CREDENTIAL_ENCRYPTION_KEY = new value
//   4) drop CREDENTIAL_ENCRYPTION_KEY_NEW
// (Rotation script not included here; build when first needed.)

import crypto from 'crypto'
import { Pool } from 'pg'
import { config } from '../config'
import { logger } from '../logger'

const KEY_BYTES  = 32
const IV_BYTES   = 12
const TAG_BYTES  = 16

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 })
  }
  return _pool
}

function getKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY env var is required. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    )
  }
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== KEY_BYTES) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`)
  }
  return buf
}

// ── Encrypt / decrypt primitives ────────────────────────────────────────────

export function encrypt(plaintext: string): Buffer {
  const key = getKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

export function decrypt(blob: Buffer): string {
  const key = getKey()
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Encrypted blob too short')
  }
  const iv  = blob.subarray(0, IV_BYTES)
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ct  = blob.subarray(IV_BYTES + TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ── Storage interface ───────────────────────────────────────────────────────

export interface CredentialRecord {
  secret: string                    // decrypted API key / token JSON
  meta:   Record<string, unknown>   // non-secret context (account id, login, etc.)
}

export async function storeCredential(
  tenantId:    string,
  integration: string,
  secret:      string,
  meta:        Record<string, unknown> = {},
): Promise<void> {
  const encryptedBlob = encrypt(secret)
  await pool().query(
    `INSERT INTO integration_credentials (tenant_id, integration, encrypted_blob, meta, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (tenant_id, integration)
     DO UPDATE SET encrypted_blob = EXCLUDED.encrypted_blob,
                   meta           = EXCLUDED.meta,
                   updated_at     = now()`,
    [tenantId, integration, encryptedBlob, JSON.stringify(meta)],
  )
  logger.info('credential_stored', { tenantId, integration })
}

export async function loadCredential(
  tenantId:    string,
  integration: string,
): Promise<CredentialRecord | null> {
  const { rows } = await pool().query<{ encrypted_blob: Buffer; meta: Record<string, unknown> }>(
    `SELECT encrypted_blob, meta FROM integration_credentials
     WHERE tenant_id = $1 AND integration = $2`,
    [tenantId, integration],
  )
  if (rows.length === 0) return null
  return {
    secret: decrypt(rows[0].encrypted_blob),
    meta:   rows[0].meta ?? {},
  }
}

export async function deleteCredential(tenantId: string, integration: string): Promise<void> {
  await pool().query(
    `DELETE FROM integration_credentials WHERE tenant_id = $1 AND integration = $2`,
    [tenantId, integration],
  )
  logger.info('credential_deleted', { tenantId, integration })
}
