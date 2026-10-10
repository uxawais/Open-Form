import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixture, bindings, validFields, FakeProvider, submit, jobs, dueAll } from './helpers.ts';
import { processDue, processDelivery } from '../src/delivery.ts';
import { createWorker } from '../src/index.ts';

let config: ReturnType<typeof fixture>, provider: FakeProvider;
beforeEach(() => { config = fixture(); provider = new FakeProvider(); });
describe('durable email delivery', () => {
  it('preserves submissions on Resend outages and retries the identical payload/key', async () => {
    provider.resendStatus = 503;
    expect((await submit(config, provider)).status).toBe(202);
    expect((await jobs()).every(job => job.status === 'pending' && job.attempts === 1)).toBe(true);
    expect((await env.DB.prepare('SELECT * FROM submissions').all()).results).toHaveLength(1);
    const payloads = (await jobs()).map(job => job.payload);
    provider.resendStatus = 200;
    await dueAll(); await processDue(bindings(), config, provider.fetch);
    expect((await jobs()).every(job => job.status === 'accepted' && job.attempts === 2)).toBe(true);
    expect((await jobs()).map(job => job.payload)).toEqual(payloads);
    expect(provider.sent()).toHaveLength(2);
  });
  it('records definite permanent failures separately for both channels', async () => {
    provider.resendStatus = 403;
    expect((await submit(config, provider)).status).toBe(202);
    expect((await jobs()).every(job => job.status === 'failed' && job.ambiguous === 0)).toBe(true);
  });
  it('recovers a lost successful response without sending a second acknowledgment', async () => {
    provider.loseResponseOnce = true;
    await submit(config, provider);
    expect(provider.sent()).toHaveLength(2);
    await dueAll(); await processDue(bindings(), config, provider.fetch);
    expect(provider.sent()).toHaveLength(2);
    expect((await jobs()).every(job => job.status === 'accepted')).toBe(true);
  });
  it('does not send email when the submission/outbox transaction fails', async () => {
    await env.DB.prepare("CREATE TRIGGER test_fail_insert BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'simulated failure'); END").run();
    try {
      expect((await submit(config, provider)).status).toBe(503);
      expect((await env.DB.prepare('SELECT * FROM submissions').all()).results).toHaveLength(0);
      expect((await env.DB.prepare('SELECT * FROM dedupe').all()).results).toHaveLength(0);
      expect(provider.sent()).toHaveLength(0);
    } finally { await env.DB.prepare('DROP TRIGGER test_fail_insert').run(); }
  });
  it('returns a safe unavailable response on rate-counter database failure', async () => {
    await env.DB.prepare("CREATE TRIGGER test_fail_rate BEFORE INSERT ON rate_counters BEGIN SELECT RAISE(ABORT, 'private database detail'); END").run();
    try {
      const response = await submit(config, provider);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('private database detail');
      expect(provider.calls).toHaveLength(0);
    } finally { await env.DB.prepare('DROP TRIGGER test_fail_rate').run(); }
  });
  it('recovers when email was accepted but the final D1 update failed', async () => {
    let installed = false;
    provider.onAccepted = async () => {
      if (!installed) {
        installed = true;
        await env.DB.prepare("CREATE TRIGGER test_fail_accept BEFORE UPDATE ON deliveries WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(ABORT, 'simulated post-send outage'); END").run();
      }
    };
    try {
      await submit(config, provider);
      expect(provider.sent()).toHaveLength(2);
      expect((await jobs()).every(job => job.status === 'processing' && job.ambiguous === 1)).toBe(true);
    } finally { await env.DB.prepare('DROP TRIGGER test_fail_accept').run(); provider.onAccepted = undefined; }
    await dueAll(); await processDue(bindings(), config, provider.fetch);
    expect(provider.sent()).toHaveLength(2);
    expect((await jobs()).every(job => job.status === 'accepted')).toBe(true);
  });
  it('honors Resend rate limits and Retry-After', async () => {
    provider.resendStatus = 429;
    provider.resendError = { name: 'rate_limit_exceeded' };
    provider.resendHeaders = { 'Retry-After': '300' };
    await submit(config, provider);
    expect((await jobs()).every(job => job.next_at >= job.first_attempt_at! + 300000 && job.error_code === 'resend_rate_limited')).toBe(true);
  });
  it.each([
    ['daily_quota_exceeded', 'resend_daily_quota'],
    ['monthly_quota_exceeded', 'resend_monthly_quota'],
  ])('records and defers provider quota %s', async (name, code) => {
    provider.resendStatus = 429; provider.resendError = { name };
    await submit(config, provider);
    expect((await jobs()).every(job => job.status === 'pending' && job.error_code === code)).toBe(true);
  });
  it('keeps accepted notification state when acknowledgment fails independently', async () => {
    provider.onAccepted = async () => { provider.resendStatus = 503; };
    await submit(config, provider);
    expect((await jobs()).find(job => job.channel === 'notification')!.status).toBe('accepted');
    expect((await jobs()).find(job => job.channel === 'acknowledgment')!.status).toBe('pending');
  });
  it('pauses sends at the configured account budget while keeping data and jobs', async () => {
    config.limits.emailDaily = 1;
    await submit(config, provider);
    expect(provider.sent()).toHaveLength(1);
    expect((await jobs()).find(job => job.channel === 'acknowledgment')!.error_code).toBe('local_email_budget');
    expect((await jobs()).find(job => job.channel === 'acknowledgment')!.first_attempt_at).toBeNull();
  });
  it('prevents concurrent processors from claiming the same job', async () => {
    provider.resendStatus = 503;
    await submit(config, provider);
    const id = (await jobs()).find(job => job.channel === 'acknowledgment')!.id;
    provider.resendStatus = 200; await dueAll();
    const before = provider.calls.filter(call => call.url.includes('resend')).length;
    await Promise.all([processDelivery(id, bindings(), config, provider.fetch), processDelivery(id, bindings(), config, provider.fetch)]);
    expect(provider.calls.filter(call => call.url.includes('resend')).length - before).toBe(1);
  });
  it('stops uncertain sends before Resend idempotency expires', async () => {
    provider.throwNetwork = true;
    await submit(config, provider);
    await env.DB.prepare('UPDATE deliveries SET first_attempt_at = ?, next_at = 0').bind(Date.now() - 24 * 3600000).run();
    const before = provider.calls.length;
    await processDue(bindings(), config, provider.fetch);
    expect(provider.calls).toHaveLength(before);
    expect((await jobs()).every(job => job.status === 'unknown' && job.error_code === 'retry_window_expired')).toBe(true);
  });
  it('marks exhausted uncertain sends for operator review', async () => {
    config.delivery.maxAttempts = 1; provider.throwNetwork = true;
    await submit(config, provider);
    expect((await jobs()).every(job => job.status === 'unknown')).toBe(true);
  });
  it('permits only safe authenticated retries, never unknown sends', async () => {
    provider.resendStatus = 403; await submit(config, provider);
    const worker = createWorker(config, provider.fetch), b = bindings();
    const job = (await jobs())[0]!;
    const retry = () => worker.fetch(new Request('https://forms.test/admin/deliveries/' + job.id + '/retry', {
      method: 'POST', headers: { Authorization: 'Bearer ' + b.ADMIN_TOKEN },
    }), b, createExecutionContext());
    expect((await retry()).status).toBe(202);
    await env.DB.prepare("UPDATE deliveries SET status = 'unknown', ambiguous = 1 WHERE id = ?").bind(job.id).run();
    expect((await retry()).status).toBe(409);
  });
  it('stores valid submissions even if the Resend key is temporarily missing', async () => {
    await submit(config, provider, validFields(), {}, 'contact', bindings({ RESEND_API_KEY: undefined }));
    expect(provider.sent()).toHaveLength(0);
    expect((await jobs()).every(job => job.status === 'pending' && job.error_code === 'resend_not_configured')).toBe(true);
  });
});
