import { log } from './errors.ts';
import { DAY } from './database.ts';
import type { Bindings, Config, Delivery, ExternalFetch } from './types.ts';

const LEASE_MS = 120000;
export function utcPeriods(now: number) {
  const iso = new Date(now).toISOString();
  const nextDay = Date.parse(iso.slice(0, 10) + 'T00:00:00.000Z') + DAY;
  const date = new Date(now);
  const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { day: iso.slice(0, 10), month: iso.slice(0, 7), nextDay, nextMonth };
}
async function finish(db: D1Database, job: Delivery, status: Delivery['status'], code: string | null, nextAt: number, ambiguous: number, providerId: string | null = null) {
  await db.prepare(
    'UPDATE deliveries SET status = ?, error_code = ?, next_at = ?, ambiguous = ?, provider_id = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_token = ?',
  ).bind(status, code, nextAt, ambiguous, providerId, Date.now(), job.id, job.lease_token).run();
  log('email_state', { deliveryId: job.id, channel: job.channel, status, code: code ?? 'none' });
}
async function reserveBudget(db: D1Database, job: Delivery, config: Config, now: number): Promise<number | undefined> {
  if (job.first_attempt_at !== null) return job.first_attempt_at;
  const period = utcPeriods(now);
  const result = await db.batch([
    db.prepare(
      'INSERT INTO email_reservations (delivery_id, day, month, cost, expires_at) ' +
      'SELECT ?, ?, ?, ?, ? WHERE ' +
      'EXISTS (SELECT 1 FROM deliveries WHERE id = ? AND lease_token = ? AND first_attempt_at IS NULL) AND ' +
      '(SELECT COALESCE(SUM(cost), 0) FROM email_reservations WHERE day = ?) + ? <= ? AND ' +
      '(SELECT COALESCE(SUM(cost), 0) FROM email_reservations WHERE month = ?) + ? <= ? ' +
      'ON CONFLICT(delivery_id) DO NOTHING',
    ).bind(job.id, period.day, period.month, job.cost, period.nextMonth + DAY, job.id, job.lease_token,
      period.day, job.cost, config.limits.emailDaily, period.month, job.cost, config.limits.emailMonthly),
    db.prepare(
      'UPDATE deliveries SET first_attempt_at = COALESCE(first_attempt_at, ?) WHERE id = ? AND lease_token = ? ' +
      'AND EXISTS (SELECT 1 FROM email_reservations WHERE delivery_id = ?) RETURNING first_attempt_at',
    ).bind(now, job.id, job.lease_token, job.id),
  ]);
  return (result[1]?.results[0] as { first_attempt_at: number } | undefined)?.first_attempt_at;
}
function retryDelay(response: Response, now: number): number | undefined {
  const header = response.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - now) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { void reader.cancel().catch(() => {}); throw new Error('invalid_response'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  return value as Record<string, unknown>;
}

export async function processDelivery(id: string, env: Bindings, config: Config, fetcher: ExternalFetch): Promise<void> {
  const db = env.DB, now = Date.now(), leaseToken = crypto.randomUUID();
  const job = await db.prepare(
    "UPDATE deliveries SET status = 'processing', lease_token = ?, lease_until = ?, next_at = ?, updated_at = ? " +
    "WHERE id = ? AND status IN ('pending', 'processing') AND next_at <= ? " +
    'AND EXISTS (SELECT 1 FROM submissions WHERE id = deliveries.submission_id AND expires_at > ?) RETURNING *',
  ).bind(leaseToken, now + LEASE_MS, now + LEASE_MS, now, id, now, now).first<Delivery>();
  if (!job) return;
  const deadline = job.first_attempt_at === null ? Infinity : job.first_attempt_at + config.delivery.retryWindowHours * 3600000;
  if (now >= deadline || job.attempts >= config.delivery.maxAttempts) {
    await finish(db, job, job.ambiguous ? 'unknown' : 'failed', now >= deadline ? 'retry_window_expired' : 'retry_exhausted', now, job.ambiguous);
    return;
  }
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith('replace-')) {
    await finish(db, job, 'pending', 'resend_not_configured', now + 15 * 60000, job.ambiguous);
    return;
  }
  const firstAttempt = await reserveBudget(db, job, config, now);
  if (firstAttempt === undefined) {
    const period = utcPeriods(now);
    const row = await db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM email_reservations WHERE month = ?').bind(period.month).first<{ cost: number }>();
    await finish(db, job, 'pending', 'local_email_budget', (row?.cost ?? 0) + job.cost > config.limits.emailMonthly ? period.nextMonth : period.nextDay, job.ambiguous);
    return;
  }
  const safeDeadline = firstAttempt + config.delivery.retryWindowHours * 3600000;
  // Mark the attempt before external I/O. A crash can leave an uncertain send,
  // which must remain protected by the same provider idempotency key.
  const started = await db.prepare(
    'UPDATE deliveries SET attempts = attempts + 1, ambiguous = 1, updated_at = ? WHERE id = ? AND lease_token = ? RETURNING attempts',
  ).bind(Date.now(), id, leaseToken).first<{ attempts: number }>();
  if (!started) return;
  if (Date.now() >= safeDeadline) {
    await finish(db, job, job.ambiguous ? 'unknown' : 'failed', 'retry_window_expired', Date.now(), job.ambiguous);
    return;
  }
  const attempts = started.attempts;
  let code = 'resend_network_error', permanent = false, ambiguous = 1;
  let nextAt = Date.now() + Math.min(60000 * 2 ** (attempts - 1), 3600000) + Math.floor(Math.random() * 10000);
  let acceptedId: string | undefined;
  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json',
        'Idempotency-Key': 'openforms/' + id,
      },
      body: job.payload,
      signal: AbortSignal.timeout(config.delivery.timeoutMs),
      // Never forward provider credentials or email content to a redirect target.
      redirect: 'manual',
    });
    let data: Record<string, unknown> = {};
    try { data = await responseJson(response); }
    catch {
      if (response.ok) throw new Error('invalid_response');
    }
    if (response.ok) {
      if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) throw new Error('invalid_response');
      acceptedId = data.id;
    } else if (response.status === 429) {
      ambiguous = job.ambiguous;
      const period = utcPeriods(Date.now());
      if (data.name === 'daily_quota_exceeded') { code = 'resend_daily_quota'; nextAt = period.nextDay; }
      else if (data.name === 'monthly_quota_exceeded') { code = 'resend_monthly_quota'; nextAt = period.nextMonth; }
      else { code = 'resend_rate_limited'; nextAt = Math.max(nextAt, Date.now() + (retryDelay(response, Date.now()) ?? 0)); }
    } else if (response.status === 409 && data.name === 'concurrent_idempotent_requests') {
      code = 'resend_concurrent_request';
    } else if (response.status >= 500 || response.status === 408) {
      code = 'resend_unavailable';
      nextAt = Math.max(nextAt, Date.now() + (retryDelay(response, Date.now()) ?? 0));
    } else {
      code = response.status === 409 ? 'resend_payload_conflict' : 'resend_rejected';
      ambiguous = job.ambiguous;
      permanent = true;
    }
  } catch {
    // Neither a network error nor a malformed success response proves that
    // Resend did not accept the email.
  }
  if (acceptedId) {
    // Keep this write OUTSIDE the fetch catch. A database failure after acceptance
    // leaves the leased job intact for recovery with the identical payload/key.
    await finish(db, job, 'accepted', null, Date.now(), 0, acceptedId);
    return;
  }
  const exhausted = permanent || attempts >= config.delivery.maxAttempts || Date.now() >= safeDeadline;
  if (exhausted) await finish(db, job, ambiguous ? 'unknown' : 'failed', code, Date.now(), ambiguous);
  else await finish(db, job, 'pending', code, Math.min(nextAt, safeDeadline), ambiguous);
}

export async function processIds(ids: string[], env: Bindings, config: Config, fetcher: ExternalFetch): Promise<void> {
  for (const id of ids) {
    try { await processDelivery(id, env, config, fetcher); }
    catch { log('email_processing_failed', { deliveryId: id, code: 'database_or_runtime_error' }); }
  }
}
export async function processDue(env: Bindings, config: Config, fetcher: ExternalFetch): Promise<void> {
  const now = Date.now();
  const jobs = await env.DB.prepare(
    "SELECT d.id FROM deliveries d JOIN submissions s ON s.id = d.submission_id WHERE d.status IN ('pending', 'processing') AND d.next_at <= ? AND s.expires_at > ? ORDER BY d.next_at, d.id LIMIT ?",
  ).bind(now, now, config.delivery.batchSize).all<{ id: string }>();
  await processIds(jobs.results.map(job => job.id), env, config, fetcher);
}
export async function retryDelivery(db: D1Database, id: string, config: Config): Promise<boolean> {
  const now = Date.now();
  const result = await db.prepare(
    "UPDATE deliveries SET status = 'pending', next_at = ?, error_code = NULL, updated_at = ? WHERE id = ? AND status = 'failed' AND ambiguous = 0 AND attempts < ? " +
    'AND (first_attempt_at IS NULL OR first_attempt_at > ?) ' +
    'AND EXISTS (SELECT 1 FROM submissions WHERE id = deliveries.submission_id AND expires_at > ?) RETURNING id',
  ).bind(now, now, id, config.delivery.maxAttempts, now - config.delivery.retryWindowHours * 3600000, now).first();
  return result !== null;
}
