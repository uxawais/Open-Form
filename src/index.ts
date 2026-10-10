import rawConfig from '../config/forms.json';
import { validateConfig } from './config.ts';
import { HttpError, log } from './errors.ts';
import { allowedOrigin, parseBody, idempotencyKey } from './request.ts';
import { validateFields } from './validation.ts';
import { authorize, hasher, verifyTurnstile } from './security.ts';
import { acknowledgmentPayload, notificationPayload } from './templates.ts';
import { cleanup, DAY, findDuplicate, getSubmission, listSubmissions, rateLimit, storeSubmission } from './database.ts';
import { processDue, processIds, retryDelivery } from './delivery.ts';
import { rememberClientKey } from './idempotency.ts';
import { failure, json, secure, success } from './response.ts';
import type { Bindings, Config, DedupeKey, ExternalFetch, FormConfig } from './types.ts';

export function createWorker(config: Config, fetcher: ExternalFetch = (url, init) => fetch(url, init)) {
  return {
    async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID(), url = new URL(request.url), development = env.ENVIRONMENT === 'development';
      let origin: string | null | undefined, form: FormConfig | undefined;
      try {
        if (!development && url.protocol !== 'https:') throw new HttpError(400, 'https_required', 'Use HTTPS.');
        if (url.pathname === '/health' && request.method === 'GET') return secure(json({ ok: true, service: 'openforms' }), requestId);
        if (url.pathname.startsWith('/admin/')) {
          await authorize(request, env);
          // Administrative endpoints intentionally have no browser CORS access.
          const list = /^\/admin\/forms\/([a-z][a-z0-9-]{0,63})\/submissions$/.exec(url.pathname);
          const item = /^\/admin\/submissions\/([a-f0-9-]{36})$/.exec(url.pathname);
          const retry = /^\/admin\/deliveries\/([a-f0-9-]{36})\/retry$/.exec(url.pathname);
          let response: Response;
          if (list && request.method === 'GET') response = json(await listSubmissions(env.DB, list[1]!, url, Date.now()));
          else if (item && request.method === 'GET') response = json(await getSubmission(env.DB, item[1]!, Date.now()));
          else if (retry && request.method === 'POST') {
            if (!await retryDelivery(env.DB, retry[1]!, config)) throw new HttpError(409, 'retry_unsafe', 'Only definite failed sends inside the retry window can be retried.');
            response = json({ ok: true, status: 'pending' }, 202);
          } else throw new HttpError(404, 'not_found', 'Endpoint not found.');
          return secure(response, requestId);
        }
        const route = /^\/f\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
        const formId = route?.[1];
        if (!formId || !Object.hasOwn(config.forms, formId) || !config.forms[formId]?.enabled) throw new HttpError(404, 'not_found', 'Form not found.');
        const selected = config.forms[formId]!;
        if (!['POST', 'OPTIONS'].includes(request.method)) {
          const response = failure(request, new HttpError(405, 'method_not_allowed', 'Use POST.'));
          response.headers.set('Allow', 'POST, OPTIONS');
          return secure(response, requestId);
        }
        origin = allowedOrigin(request, selected, development);
        form = selected; // Only approved origins may receive configured redirects.
        if (request.method === 'OPTIONS') {
          if (request.headers.get('Access-Control-Request-Method') !== 'POST') throw new HttpError(403, 'cors_forbidden', 'This CORS request is not allowed.');
          const requested = (request.headers.get('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
          if (requested.some(value => !['content-type', 'idempotency-key'].includes(value))) throw new HttpError(403, 'cors_forbidden', 'This CORS request is not allowed.');
          return secure(new Response(null, { status: 204, headers: {
            'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
            'Access-Control-Max-Age': '600',
          } }), requestId, origin);
        }
        const hash = await hasher(env.ABUSE_SECRET);
        // Cloudflare sets this header at the edge. Never trust X-Forwarded-For.
        // Missing IPs share one conservative bucket, including local development.
        const ipHash = await hash('ip:' + (request.headers.get('CF-Connecting-IP') ?? 'missing'));
        const now = Date.now(), windowMs = form.rateLimit.windowSeconds * 1000;
        const windowStart = Math.floor(now / windowMs) * windowMs, windowEnd = windowStart + windowMs;
        await rateLimit(env.DB, 'ip:' + formId + ':' + ipHash + ':' + windowStart, form.rateLimit.max, windowEnd, Math.ceil((windowEnd - now) / 1000));
        const raw = await parseBody(request, config.limits.bodyBytes, config.limits.fieldCount);
        if (form.honeypot && raw[form.honeypot]) return secure(success(request, form, development), requestId, origin);
        const fields = validateFields(raw, form), clientKey = idempotencyKey(request, raw);
        const payloadHash = await hash('payload:' + formId + ':' + (origin ?? '') + ':' + JSON.stringify(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))));
        const keys: DedupeKey[] = [];
        if (clientKey) keys.push({ key: 'idempotency:' + await hash(formId + ':' + clientKey), expiresAt: now + DAY });
        const token = raw['cf-turnstile-response'];
        if (form.turnstile.enabled && (!token || token.length > 2048)) throw new HttpError(400, 'verification_failed', 'Complete the spam verification and try again.');
        if (form.turnstile.enabled && token) keys.push({ key: 'token:' + await hash(token), expiresAt: now + 600000 });
        if (form.duplicateWindowSeconds) keys.push({
          key: 'content:' + await hash(formId + ':' + ipHash + ':' + payloadHash),
          expiresAt: now + form.duplicateWindowSeconds * 1000,
        });
        const duplicate = await findDuplicate(env.DB, keys, payloadHash, now);
        if (duplicate) {
          await rememberClientKey(env.DB, keys.find(key => key.key.startsWith('idempotency:')), duplicate, payloadHash, now);
          return secure(success(request, form, development, duplicate, true), requestId, origin);
        }
        await verifyTurnstile(token, form, env, fetcher, origin);
        const id = crypto.randomUUID(), ack = acknowledgmentPayload(config, formId, id, fields, form);
        const stored = await storeSubmission(env.DB, {
          id, formId, fields, now, expiresAt: now + form.retentionDays * DAY, keys, payloadHash,
          notification: notificationPayload(formId, id, now, fields, form),
          acknowledgment: ack.payload, ackReason: ack.reason,
          ackKey: ack.recipient ? 'ack:' + await hash(ack.recipient) : undefined,
        });
        if (stored.duplicate) await rememberClientKey(env.DB, keys.find(key => key.key.startsWith('idempotency:')), stored.id, payloadHash, now);
        if (stored.deliveryIds.length) ctx.waitUntil(processIds(stored.deliveryIds, env, config, fetcher));
        log('submission_received', { requestId, formId, submissionId: stored.id, duplicate: stored.duplicate ? 1 : 0 });
        return secure(success(request, form, development, stored.id, stored.duplicate), requestId, origin);
      } catch (error) {
        const safe = error instanceof HttpError ? error : new HttpError(503, 'storage_unavailable', 'The form service is temporarily unavailable. Try again later.', undefined, 60);
        log('request_failed', { requestId, code: safe.code, status: safe.status });
        return secure(failure(request, safe, form, development), requestId, origin);
      }
    },
    async scheduled(_controller: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
      try {
        await processDue(env, config, fetcher);
        await cleanup(env.DB, Date.now());
      } catch {
        log('scheduled_failed', { code: 'database_or_runtime_error' });
        throw new Error('OpenForms scheduled maintenance failed');
      }
    },
  };
}

export default createWorker(validateConfig(rawConfig));
