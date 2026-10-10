import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, createScheduledController } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, bindings, validFields, FakeProvider, submit, jobs } from './helpers.ts';
import { createWorker } from '../src/index.ts';
import { DAY, cleanup } from '../src/database.ts';

let config: ReturnType<typeof fixture>, provider: FakeProvider;
beforeEach(() => { config = fixture(); provider = new FakeProvider(); });

describe('submission API with real D1 storage', () => {
  it('stores valid JSON, then sends owner and personalized acknowledgment', async () => {
    const response = await submit(config, provider);
    expect(response.status).toBe(202);
    const body = await response.json() as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect((await env.DB.prepare('SELECT fields_json FROM submissions WHERE id = ?').bind(body.id).first())?.fields_json).toContain('Ada Lovelace');
    expect((await jobs()).map(job => job.status)).toEqual(['accepted', 'accepted']);
    expect(provider.sent()).toHaveLength(2);
    const ack = provider.sent().find(email => email.to.includes('ada@visitor.test'))!;
    expect(ack.text).toContain('Hi Ada Lovelace');
    expect(ack.text).not.toContain('I have a question');
    expect(ack.from).toBe('Example Website <forms@sender.test>');
  });
  it('uses real deployed-export routing for liveness and disabled sample forms', async () => {
    expect((await exports.default.fetch('https://forms.test/health')).status).toBe(200);
    expect((await exports.default.fetch('https://forms.test/f/contact', { method: 'POST' })).status).toBe(404);
  });
  it.each([
    [{ name: '' }, 'name', 'required'],
    [{ email: 'not-an-email' }, 'email', 'invalid_email'],
    [{ email: 'victim@visitor.test\r\nBcc:other@visitor.test' }, 'email', 'invalid_email'],
    [{ message: 'Hi' }, 'message', 'too_short'],
    [{ message: 'x'.repeat(8001) }, 'message', 'too_long'],
    [{ extra: 'unexpected' }, 'extra', 'unknown_field'],
  ])('rejects invalid fields %# without storage or email', async (extra, field, code) => {
    const response = await submit(config, provider, validFields(extra));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: { fields: Record<string, string> } };
    expect(body.error.fields[field]).toBe(code);
    expect(await jobs()).toHaveLength(0);
    expect(provider.sent()).toHaveLength(0);
  });
  it.each(['{', '[]', '"string"', '{"name":42}', '{"__proto__":"bad"}'])('rejects malformed or unsafe JSON %s', async body => {
    expect((await submit(config, provider, validFields(), { body })).status).toBe(400);
    expect(await jobs()).toHaveLength(0);
  });
  it('rejects unsupported media and compressed bodies', async () => {
    expect((await submit(config, provider, validFields(), { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await submit(config, provider, validFields(), { headers: { 'Content-Encoding': 'gzip' } })).status).toBe(415);
  });
  it('rejects malformed URL encoding and invalid UTF-8', async () => {
    expect((await submit(config, provider, validFields(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=%ZZ' })).status).toBe(400);
    expect((await submit(config, provider, validFields(), { body: new Uint8Array([0xff]) })).status).toBe(400);
  });
  it('enforces actual streamed bytes with no Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(20000)); controller.enqueue(new Uint8Array(20000)); controller.close(); },
    });
    expect((await submit(config, provider, validFields(), { body: stream })).status).toBe(413);
    expect(provider.calls).toHaveLength(0);
  });
  it('rejects too many fields and duplicate URL-encoded fields', async () => {
    const fields = Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['field' + i, 'x']));
    expect((await submit(config, provider, fields)).status).toBe(413);
    expect((await submit(config, provider, validFields(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=first&name=second' })).status).toBe(400);
  });
  it('handles functional URL-encoded HTML submission and success redirect', async () => {
    config.forms.contact!.redirects.success = 'https://site.test/thanks';
    const response = await submit(config, provider, validFields(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: new URLSearchParams(validFields()),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://site.test/thanks');
    expect(await jobs()).toHaveLength(2);
  });
  it('returns a readable HTML success page when no redirect is configured', async () => {
    const response = await submit(config, provider, validFields(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: new URLSearchParams(validFields()),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('Submission received');
  });
  it('redirects errors with a stable code and no submitted values', async () => {
    config.forms.contact!.redirects.error = 'https://site.test/error?source=contact';
    const response = await submit(config, provider, validFields({ email: 'private-invalid-value' }), {
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(validFields({ email: 'private-invalid-value' })),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://site.test/error?source=contact&openforms_error=validation_failed');
  });
  it('supports text-only multipart and rejects uploaded files', async () => {
    const data = new FormData();
    for (const [key, value] of Object.entries(validFields())) data.set(key, value);
    const ctx = createExecutionContext();
    const worker = createWorker(config, provider.fetch);
    const response = await worker.fetch(new Request('https://forms.test/f/contact', { method: 'POST', headers: { Origin: 'https://site.test' }, body: data }), bindings(), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(202);
    data.set('attachment', new File(['private'], 'file.txt'));
    const other = createExecutionContext();
    const rejected = await worker.fetch(new Request('https://forms.test/f/contact', { method: 'POST', headers: { Origin: 'https://site.test' }, body: data }), bindings(), other);
    expect(rejected.status).toBe(400);
  });
  it('quietly discards honeypot spam', async () => {
    expect((await submit(config, provider, validFields({ _gotcha: 'bot' }))).status).toBe(202);
    expect(provider.calls).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
  });
  it('escapes HTML, prevents subject header injection, and limits acknowledgment reflection', async () => {
    const response = await submit(config, provider, validFields({ name: 'Mallory\r\nBcc: evil', message: '<img src=x onerror=alert(1)>' }));
    expect(response.status).toBe(202);
    const owner = provider.sent().find(email => email.to.includes('owner@sender.test'))!;
    expect(owner.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(owner.html).not.toContain('<img');
    expect(owner.subject).not.toMatch(/[\r\n]/);
    expect(provider.sent().find(email => email.to.includes('ada@visitor.test'))!.text).toContain('Hi there');
  });
  it('suppresses acknowledgments to any configured sender or owner', async () => {
    await submit(config, provider, validFields({ email: 'owner@sender.test' }));
    expect(provider.sent()).toHaveLength(1);
    expect((await jobs()).find(job => job.channel === 'acknowledgment')!.error_code).toBe('loop_prevention');
  });
  it('queues at most one acknowledgment per recipient across forms in 24 hours', async () => {
    await submit(config, provider);
    await submit(config, provider, validFields({ message: 'A second different question' }));
    expect(provider.sent()).toHaveLength(3);
    expect((await jobs()).filter(job => job.error_code === 'recipient_cooldown')).toHaveLength(1);
  });
  it('applies independently configured newsletter and feedback validation', async () => {
    provider.turnstile.action = 'newsletter';
    expect((await submit(config, provider, { email: 'new@visitor.test', 'cf-turnstile-response': crypto.randomUUID() }, {}, 'newsletter')).status).toBe(202);
    provider.turnstile.action = 'feedback';
    expect((await submit(config, provider, { rating: '9', message: 'Feedback message', 'cf-turnstile-response': crypto.randomUUID() }, {}, 'feedback')).status).toBe(422);
    expect((await submit(config, provider, { rating: '5', message: 'Feedback message', 'cf-turnstile-response': crypto.randomUUID() }, {}, 'feedback')).status).toBe(202);
    expect((await env.DB.prepare('SELECT DISTINCT form_id FROM submissions').all()).results.map(row => row.form_id).sort()).toEqual(['feedback', 'newsletter']);
  });
  it('does not log field content, upstream messages, or API keys', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      provider.resendStatus = 500;
      await submit(config, provider, validFields({ message: 'SECRET_MESSAGE_CONTENT' }));
      const output = JSON.stringify(logs.mock.calls);
      expect(output).not.toContain('SECRET_MESSAGE_CONTENT');
      expect(output).not.toContain('re_test_only');
      expect(output).not.toContain('private upstream message');
    } finally { logs.mockRestore(); }
  });
  it('deletes expired data and dependent jobs without resetting monthly budgets', async () => {
    await submit(config, provider);
    await env.DB.prepare('UPDATE submissions SET created_at = ?, expires_at = ?').bind(Date.now() - 2 * DAY, Date.now() - DAY).run();
    await cleanup(env.DB, Date.now());
    expect((await env.DB.prepare('SELECT * FROM submissions').all()).results).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect((await env.DB.prepare('SELECT * FROM dedupe').all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT * FROM email_reservations').all()).results).toHaveLength(2);
  });
  it('runs scheduled maintenance through the actual scheduled handler', async () => {
    await submit(config, provider);
    const ctx = createExecutionContext();
    await createWorker(config, provider.fetch).scheduled(createScheduledController(), bindings(), ctx);
    expect((await jobs()).every(job => job.status === 'accepted')).toBe(true);
  });
});
