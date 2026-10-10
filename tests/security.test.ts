import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixture, bindings, validFields, FakeProvider, submit, jobs } from './helpers.ts';
import { createWorker } from '../src/index.ts';
import { validateConfig } from '../src/config.ts';
import rawConfig from '../config/forms.json';
import { isEmail } from '../src/validation.ts';

let config: ReturnType<typeof fixture>, provider: FakeProvider;
beforeEach(() => { config = fixture(); provider = new FakeProvider(); });
describe('security controls', () => {
  it('constructs provider requests using the native Workers Request implementation', async () => {
    const requests: Request[] = [];
    const worker = createWorker(config, (url, init) => {
      // The HTTP double alone does not validate Workers-specific request options.
      requests.push(new Request(url, init));
      return provider.fetch(url, init);
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://forms.test/f/contact', {
      method: 'POST', headers: { Origin: 'https://site.test', 'Content-Type': 'application/json' },
      body: JSON.stringify(validFields()),
    }), bindings(), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(202);
    expect((await jobs()).map(job => job.status)).toEqual(['accepted', 'accepted']);
    expect(requests.map(request => request.redirect)).toEqual(['manual', 'manual', 'manual']);
  });
  it.each([
    { success: false, 'error-codes': ['invalid-input-response'] },
    { success: true, hostname: 'attacker.test', action: 'contact' },
    { success: true, hostname: 'site.test', action: 'newsletter' },
  ])('rejects invalid Turnstile token or metadata %#', async result => {
    provider.turnstile = result;
    expect((await submit(config, provider)).status).toBe(400);
    expect(await jobs()).toHaveLength(0);
    expect(provider.sent()).toHaveLength(0);
  });
  it('rejects missing tokens and production dummy keys', async () => {
    expect((await submit(config, provider, validFields({ 'cf-turnstile-response': '' }))).status).toBe(400);
    expect((await submit(config, provider, validFields(), {}, 'contact',
      bindings({ TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }))).status).toBe(503);
  });
  it('fails closed when Turnstile itself is unavailable', async () => {
    provider.turnstile = { success: false, 'error-codes': ['internal-error'] };
    expect((await submit(config, provider)).status).toBe(503);
    expect(await jobs()).toHaveLength(0);
  });
  it('blocks disallowed origins without granting CORS or redirecting', async () => {
    config.forms.contact!.redirects.error = 'https://site.test/error';
    const response = await submit(config, provider, validFields(), { headers: { Origin: 'https://evil.test', Accept: 'text/html' } });
    expect(response.status).toBe(403);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });
  it('requires an Origin unless explicitly configured for clients without one', async () => {
    const worker = createWorker(config, provider.fetch);
    const request = () => new Request('https://forms.test/f/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validFields()) });
    expect((await worker.fetch(request(), bindings(), createExecutionContext())).status).toBe(403);
    config.forms.contact!.allowMissingOrigin = true;
    const contexts: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => contexts.push(promise) } as unknown as ExecutionContext;
    expect((await createWorker(config, provider.fetch).fetch(request(), bindings(), ctx)).status).toBe(202);
    await Promise.all(contexts);
  });
  it('returns restricted CORS preflight and response headers for approved origins', async () => {
    const worker = createWorker(config, provider.fetch);
    const preflight = (headers: Record<string, string>) => worker.fetch(new Request('https://forms.test/f/contact', {
      method: 'OPTIONS', headers: { Origin: 'https://site.test', 'Access-Control-Request-Method': 'POST', ...headers },
    }), bindings(), createExecutionContext());
    const response = await preflight({ 'Access-Control-Request-Headers': 'content-type,idempotency-key' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://site.test');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect((await preflight({ 'Access-Control-Request-Headers': 'authorization' })).status).toBe(403);
    const submitted = await submit(config, provider);
    expect(submitted.headers.get('Cache-Control')).toBe('no-store');
    expect(submitted.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('blocks private access without a correct bearer token', async () => {
    const worker = createWorker(config, provider.fetch);
    for (const path of ['/admin/forms/contact/submissions', '/admin/submissions/' + crypto.randomUUID(), '/admin/deliveries/' + crypto.randomUUID() + '/retry']) {
      expect((await worker.fetch(new Request('https://forms.test' + path), bindings(), createExecutionContext())).status).toBe(401);
    }
    expect((await worker.fetch(new Request('https://forms.test/admin/forms/contact/submissions', {
      headers: { Authorization: 'Bearer wrong-token' },
    }), bindings(), createExecutionContext())).status).toBe(401);
  });
  it('retrieves stored fields privately and paginates with a bounded cursor', async () => {
    await submit(config, provider);
    await submit(config, provider, validFields({ message: 'Another question for the team' }));
    const worker = createWorker(config, provider.fetch), b = bindings();
    const get = (path: string) => worker.fetch(new Request('https://forms.test' + path, { headers: { Authorization: 'Bearer ' + b.ADMIN_TOKEN, Origin: 'https://site.test' } }), b, createExecutionContext());
    const first = await get('/admin/forms/contact/submissions?limit=1');
    const page = await first.json() as { submissions: { id: string }[]; nextCursor: string };
    expect(page.submissions).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    expect(first.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const second = await get('/admin/forms/contact/submissions?limit=1&cursor=' + encodeURIComponent(page.nextCursor));
    expect((await second.json() as { submissions: unknown[] }).submissions).toHaveLength(1);
    const detail = await get('/admin/submissions/' + page.submissions[0]!.id);
    expect((await detail.json() as { fields: { email: string } }).fields.email).toBe('ada@visitor.test');
    expect((await get('/admin/forms/contact/submissions?limit=500')).status).toBe(400);
    expect((await get('/admin/forms/contact/submissions?cursor=bad')).status).toBe(400);
  });
  it('rejects replayed tokens with changed fields', async () => {
    const fields = validFields();
    await submit(config, provider, fields);
    expect((await submit(config, provider, { ...fields, message: 'Changed after successful verification' })).status).toBe(409);
    expect(provider.sent()).toHaveLength(2);
  });
  it('returns the same receipt for lost-response retry without duplicate emails', async () => {
    const fields = validFields(), key = crypto.randomUUID();
    const first = await submit(config, provider, fields, { headers: { 'Idempotency-Key': key } });
    const second = await submit(config, provider, fields, { headers: { 'Idempotency-Key': key } });
    const a = await first.json() as { id: string }, b = await second.json() as { id: string; duplicate: boolean };
    expect(b.id).toBe(a.id); expect(b.duplicate).toBe(true);
    expect(provider.sent()).toHaveLength(2);
    expect(provider.calls.filter(call => call.url.includes('siteverify'))).toHaveLength(1);
  });
  it('deduplicates a double-click with a new Turnstile token and no client key', async () => {
    const a = await submit(config, provider), b = await submit(config, provider);
    expect((await a.json() as { id: string }).id).toBe((await b.json() as { id: string }).id);
    expect(provider.sent()).toHaveLength(2);
  });
  it('binds a new client key to a content duplicate for later retry safety', async () => {
    await submit(config, provider);
    const key = crypto.randomUUID();
    const duplicate = await submit(config, provider, validFields(), { headers: { 'Idempotency-Key': key } });
    expect((await duplicate.json() as { duplicate: boolean }).duplicate).toBe(true);
    await env.DB.prepare("DELETE FROM dedupe WHERE key LIKE 'content:%'").run();
    const conflicting = await submit(config, provider, validFields({ message: 'Changed fields after content expiry' }), { headers: { 'Idempotency-Key': key } });
    expect(conflicting.status).toBe(409);
    expect(provider.sent()).toHaveLength(2);
  });
  it('accepts dummy metadata only with an explicit development dummy key', async () => {
    provider.turnstile = { success: true, hostname: 'dummy.test', action: 'dummy' };
    expect((await submit(config, provider, validFields(), {}, 'contact',
      bindings({ ENVIRONMENT: 'development', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }))).status).toBe(202);
  });
  it('keeps preflight errors as errors even with HTML redirect preferences', async () => {
    config.forms.contact!.redirects.error = 'https://site.test/error';
    const response = await createWorker(config, provider.fetch).fetch(new Request('https://forms.test/f/contact', {
      method: 'OPTIONS', headers: { Origin: 'https://site.test', Accept: 'text/html', 'Access-Control-Request-Method': 'DELETE' },
    }), bindings(), createExecutionContext());
    expect(response.status).toBe(403);
    expect(response.headers.get('Location')).toBeNull();
  });
  it('returns 405 for non-submission methods and requires HTTPS in production', async () => {
    const worker = createWorker(config, provider.fetch);
    const method = await worker.fetch(new Request('https://forms.test/f/contact'), bindings(), createExecutionContext());
    expect(method.status).toBe(405);
    expect(method.headers.get('Allow')).toBe('POST, OPTIONS');
    expect((await worker.fetch(new Request('http://forms.test/health'), bindings(), createExecutionContext())).status).toBe(400);
  });
  it('independently enforces per-form limits and honors configured origins', async () => {
    config.forms.contact!.rateLimit.max = 1;
    await submit(config, provider);
    expect((await submit(config, provider)).status).toBe(429);
    provider.turnstile.action = 'newsletter';
    expect((await submit(config, provider, { email: 'new@visitor.test', 'cf-turnstile-response': crypto.randomUUID() }, {}, 'newsletter')).status).toBe(202);
    config.forms.feedback!.allowedOrigins = ['https://other.test'];
    expect((await submit(config, provider, { rating: '5', message: 'Good', 'cf-turnstile-response': crypto.randomUUID() }, {}, 'feedback')).status).toBe(403);
  });
  it('rejects conflicting or weak client keys', async () => {
    expect((await submit(config, provider, validFields(), { headers: { 'Idempotency-Key': 'short' } })).status).toBe(400);
    const key = crypto.randomUUID();
    await submit(config, provider, validFields(), { headers: { 'Idempotency-Key': key } });
    expect((await submit(config, provider, validFields({ message: 'Different payload under the same key' }), { headers: { 'Idempotency-Key': key } })).status).toBe(409);
  });
  it('atomically deduplicates concurrent submissions', async () => {
    const key = crypto.randomUUID();
    const responses = await Promise.all(Array.from({ length: 5 }, () => submit(config, provider, validFields(), { headers: { 'Idempotency-Key': key } })));
    expect(responses.map(response => response.status)).toEqual([202, 202, 202, 202, 202]);
    expect((await env.DB.prepare('SELECT * FROM submissions').all()).results).toHaveLength(1);
    expect(provider.sent()).toHaveLength(2);
  });
  it('uses persistent per-form IP limits even when requests overlap', async () => {
    config.forms.contact!.rateLimit.max = 2;
    const responses = await Promise.all(Array.from({ length: 4 }, (_, i) => submit(config, provider, validFields({ message: 'Distinct message number ' + i }))));
    expect(responses.filter(response => response.status === 202)).toHaveLength(2);
    const rejected = responses.filter(response => response.status === 429);
    expect(rejected).toHaveLength(2);
    expect(Number(rejected[0]!.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
  it('does not expose expired submissions even before physical cleanup', async () => {
    const response = await submit(config, provider), id = (await response.json() as { id: string }).id;
    await env.DB.prepare('UPDATE submissions SET created_at = 0, expires_at = 1 WHERE id = ?').bind(id).run();
    const b = bindings();
    const detail = await createWorker(config, provider.fetch).fetch(new Request('https://forms.test/admin/submissions/' + id, {
      headers: { Authorization: 'Bearer ' + b.ADMIN_TOKEN },
    }), b, createExecutionContext());
    expect(detail.status).toBe(404);
  });
  it('validates configuration typos, unsafe templates, redirects, and acknowledgment requirements', () => {
    const clone = () => structuredClone(rawConfig);
    let bad = clone();
    bad.forms.contact.notification.subject = 'Injected\r\nheader';
    expect(() => validateConfig(bad)).toThrow();
    bad = clone(); bad.forms.contact.notification.html = '<a href="{{message}}">click</a>';
    expect(() => validateConfig(bad)).toThrow();
    bad = clone(); bad.forms.contact.acknowledgment.text = '{{message}}';
    expect(() => validateConfig(bad)).toThrow();
    bad = clone(); bad.forms.contact.acknowledgment.enabled = true; bad.forms.contact.turnstile.enabled = false;
    expect(() => validateConfig(bad)).toThrow();
    expect(() => validateConfig({ ...clone(), typo: true })).toThrow();
    expect(isEmail('user..name@domain.test')).toBe(false);
    expect(isEmail('user@-domain.test')).toBe(false);
  });
});
