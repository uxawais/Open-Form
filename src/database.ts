import { HttpError } from './errors.ts';
import type { DedupeKey, Delivery, MailPayload, SubmissionRow } from './types.ts';

export const DAY = 86400000;
export async function rateLimit(db: D1Database, key: string, max: number, expiresAt: number, retryAfter: number): Promise<void> {
  const result = await db.prepare(
    'INSERT INTO rate_counters (key, count, expires_at) VALUES (?, 1, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count',
  ).bind(key, expiresAt, max).first();
  if (!result) throw new HttpError(429, 'rate_limited', 'Too many requests. Try again later.', undefined, retryAfter);
}

export async function findDuplicate(db: D1Database, keys: DedupeKey[], hash: string, now: number): Promise<string | undefined> {
  if (!keys.length) return undefined;
  const result = await db.prepare(
    'SELECT key, submission_id, payload_hash FROM dedupe WHERE key IN (' + keys.map(() => '?').join(',') + ') AND expires_at > ?',
  ).bind(...keys.map(key => key.key), now).all<{ key: string; submission_id: string; payload_hash: string }>();
  for (const row of result.results) {
    if (row.payload_hash !== hash) throw new HttpError(409, 'idempotency_conflict', 'This idempotency key or verification token was already used with different fields.');
  }
  return result.results[0]?.submission_id;
}

export interface StoreInput {
  id: string; formId: string; fields: Record<string, string>; now: number; expiresAt: number;
  keys: DedupeKey[]; payloadHash: string; notification: MailPayload;
  acknowledgment?: MailPayload; ackReason?: string; ackKey?: string;
}
export async function storeSubmission(db: D1Database, input: StoreInput): Promise<{ id: string; duplicate: boolean; deliveryIds: string[] }> {
  const { id, now } = input;
  const notificationId = crypto.randomUUID(), ackId = crypto.randomUUID();
  const statements = [
    db.prepare('INSERT INTO submissions (id, form_id, fields_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, input.formId, JSON.stringify(input.fields), now, input.expiresAt),
  ];
  for (const item of input.keys) {
    statements.push(db.prepare('DELETE FROM dedupe WHERE key = ? AND expires_at <= ?').bind(item.key, now));
    statements.push(db.prepare('INSERT INTO dedupe (key, submission_id, payload_hash, expires_at) VALUES (?, ?, ?, ?)')
      .bind(item.key, id, input.payloadHash, item.expiresAt));
  }
  const insertDelivery = (jobId: string, channel: string, payload: MailPayload | undefined, reason?: string) =>
    db.prepare('INSERT INTO deliveries (id, submission_id, channel, status, payload, cost, next_at, error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(jobId, id, channel, payload && channel === 'notification' ? 'pending' : 'skipped',
        payload ? JSON.stringify(payload) : null, payload?.to.length ?? 0, now, reason ?? null, now, now);
  statements.push(insertDelivery(notificationId, 'notification', input.notification));
  statements.push(insertDelivery(ackId, 'acknowledgment', input.acknowledgment, input.acknowledgment ? 'recipient_cooldown' : input.ackReason));
  if (input.acknowledgment && input.ackKey) {
    // The global recipient key spans all forms. The transaction reserves one
    // acknowledgment per rolling 24 hours, only for successfully stored data.
    statements.push(db.prepare(
      'INSERT INTO rate_counters (key, count, expires_at) VALUES (?, 1, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET count = 1, expires_at = excluded.expires_at WHERE rate_counters.expires_at <= ?',
    ).bind(input.ackKey, now + DAY, now));
    statements.push(db.prepare("UPDATE deliveries SET status = 'pending', error_code = NULL WHERE id = ? AND changes() = 1").bind(ackId));
  }
  statements.push(db.prepare("UPDATE deliveries SET payload = NULL, cost = 0 WHERE id = ? AND status = 'skipped'").bind(ackId));
  try { await db.batch(statements); }
  catch (error) {
    const duplicate = await findDuplicate(db, input.keys, input.payloadHash, now);
    if (duplicate) return { id: duplicate, duplicate: true, deliveryIds: [] };
    throw error;
  }
  return { id, duplicate: false, deliveryIds: [notificationId, ackId] };
}

function deliveryView(job: Delivery) {
  return {
    id: job.id, channel: job.channel, status: job.status, attempts: job.attempts,
    providerId: job.provider_id, errorCode: job.error_code,
    nextAttemptAt: job.status === 'pending' || job.status === 'processing' ? new Date(job.next_at).toISOString() : null,
  };
}
function submissionView(row: SubmissionRow, deliveries: Delivery[]) {
  return {
    id: row.id, formId: row.form_id, fields: JSON.parse(row.fields_json) as Record<string, string>,
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    deliveries: deliveries.map(deliveryView),
  };
}
export async function getSubmission(db: D1Database, id: string, now: number) {
  const row = await db.prepare('SELECT * FROM submissions WHERE id = ? AND expires_at > ?').bind(id, now).first<SubmissionRow>();
  if (!row) throw new HttpError(404, 'not_found', 'Submission not found.');
  const jobs = await db.prepare('SELECT * FROM deliveries WHERE submission_id = ? ORDER BY channel').bind(id).all<Delivery>();
  return submissionView(row, jobs.results);
}
export async function listSubmissions(db: D1Database, formId: string, url: URL, now: number) {
  const rawLimit = url.searchParams.get('limit') ?? '25';
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) throw new HttpError(400, 'invalid_pagination', 'Limit must be between 1 and 50.');
  const limit = Number(rawLimit);
  let time = Number.MAX_SAFE_INTEGER, id = '~';
  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    try {
      if (cursor.length > 256) throw new Error('invalid');
      const parsed: unknown = JSON.parse(atob(cursor));
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
      const value = parsed as Record<string, unknown>;
      if (!Number.isSafeInteger(value.time) || typeof value.time !== 'number' || value.time < 0 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw new Error('invalid');
      time = value.time; id = value.id;
    } catch { throw new HttpError(400, 'invalid_pagination', 'Invalid cursor.'); }
  }
  const result = await db.prepare(
    'SELECT * FROM submissions WHERE form_id = ? AND expires_at > ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?',
  ).bind(formId, now, time, time, id, limit + 1).all<SubmissionRow>();
  const rows = result.results.slice(0, limit);
  const jobs = rows.length ? (await db.prepare('SELECT * FROM deliveries WHERE submission_id IN (' + rows.map(() => '?').join(',') + ') ORDER BY channel')
    .bind(...rows.map(row => row.id)).all<Delivery>()).results : [];
  const last = rows.at(-1);
  return {
    submissions: rows.map(row => submissionView(row, jobs.filter(job => job.submission_id === row.id))),
    nextCursor: result.results.length > limit && last ? btoa(JSON.stringify({ time: last.created_at, id: last.id })) : null,
  };
}

export async function cleanup(db: D1Database, now: number): Promise<void> {
  // Bounded, indexed deletes keep each invocation small; more runs catch up.
  await db.batch([
    db.prepare('DELETE FROM submissions WHERE id IN (SELECT id FROM submissions WHERE expires_at <= ? ORDER BY expires_at LIMIT 50)').bind(now),
    db.prepare('DELETE FROM dedupe WHERE key IN (SELECT key FROM dedupe WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').bind(now),
    db.prepare('DELETE FROM rate_counters WHERE key IN (SELECT key FROM rate_counters WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').bind(now),
    db.prepare('DELETE FROM email_reservations WHERE delivery_id IN (SELECT delivery_id FROM email_reservations WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)').bind(now),
  ]);
}
