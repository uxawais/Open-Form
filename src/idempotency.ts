import { HttpError } from './errors.ts';
import type { DedupeKey } from './types.ts';

// Bind a new client key when content deduplication returns an existing receipt.
// Never record unverified Turnstile tokens here.
export async function rememberClientKey(db: D1Database, key: DedupeKey | undefined, id: string, payloadHash: string, now: number) {
  if (!key) return;
  await db.batch([
    db.prepare('DELETE FROM dedupe WHERE key = ? AND expires_at <= ?').bind(key.key, now),
    db.prepare(
      'INSERT INTO dedupe (key, submission_id, payload_hash, expires_at) ' +
      'SELECT ?, id, ?, MIN(expires_at, ?) FROM submissions WHERE id = ? AND expires_at > ? ON CONFLICT(key) DO NOTHING',
    ).bind(key.key, payloadHash, key.expiresAt, id, now),
  ]);
  const row = await db.prepare('SELECT payload_hash FROM dedupe WHERE key = ? AND expires_at > ?').bind(key.key, now).first<{ payload_hash: string }>();
  if (!row) throw new HttpError(503, 'storage_unavailable', 'The form service is temporarily unavailable.');
  if (row.payload_hash !== payloadHash) throw new HttpError(409, 'idempotency_conflict', 'This idempotency key was already used with different fields.');
}
