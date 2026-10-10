import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import rawConfig from '../config/forms.json';
import { validateConfig } from '../src/config.ts';
import { createWorker } from '../src/index.ts';
import type { Bindings, Config, Delivery, ExternalFetch, MailPayload } from '../src/types.ts';

export function fixture(): Config {
  const raw = structuredClone(rawConfig);
  for (const form of Object.values(raw.forms)) {
    form.enabled = true;
    form.allowedOrigins = ['https://site.test'];
    form.turnstile.hostnames = ['site.test'];
    form.notification.from.email = 'forms@sender.test';
    form.notification.to = ['owner@sender.test'];
    if (form.notification.replyTo !== 'submitter') form.notification.replyTo = 'owner@sender.test';
    if ('replyTo' in form.acknowledgment) form.acknowledgment.replyTo = 'owner@sender.test';
  }
  raw.forms.contact.acknowledgment.enabled = true;
  return validateConfig(raw);
}
export function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: env.DB,
    ENVIRONMENT: 'production',
    ADMIN_TOKEN: 'test-admin-secret-' + 'a'.repeat(40),
    ABUSE_SECRET: 'test-abuse-secret-' + 'b'.repeat(40),
    RESEND_API_KEY: 're_test_only',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    ...overrides,
  };
}
export const validFields = (extra: Record<string, string> = {}) => ({
  name: 'Ada Lovelace', email: 'ada@visitor.test', message: 'Hello, I have a question.',
  'cf-turnstile-response': crypto.randomUUID(), ...extra,
});

export class FakeProvider {
  calls: { url: string; init: RequestInit }[] = [];
  emails = new Map<string, { payload: string; id: string }>();
  turnstile: Record<string, unknown> = { success: true, action: 'contact', hostname: 'site.test' };
  resendStatus = 200;
  resendError: Record<string, unknown> = { name: 'internal_server_error', message: 'Do not log this private upstream message' };
  resendHeaders: Record<string, string> = {};
  throwNetwork = false;
  loseResponseOnce = false;
  onAccepted?: () => Promise<void>;
  fetch: ExternalFetch = async (url, init) => {
    this.calls.push({ url, init });
    if (url.includes('siteverify')) return Response.json(this.turnstile);
    if (url !== 'https://api.resend.com/emails') throw new Error('Unexpected external API');
    if (this.throwNetwork) throw new Error('private transport error');
    if (this.resendStatus !== 200) return Response.json(this.resendError, { status: this.resendStatus, headers: this.resendHeaders });
    const key = new Headers(init.headers).get('Idempotency-Key')!;
    const payload = String(init.body);
    const existing = this.emails.get(key);
    if (existing && existing.payload !== payload) return Response.json({ name: 'invalid_idempotent_request' }, { status: 409 });
    const id = existing?.id ?? crypto.randomUUID();
    this.emails.set(key, { payload, id });
    await this.onAccepted?.();
    if (this.loseResponseOnce) { this.loseResponseOnce = false; throw new Error('connection lost after provider accepted'); }
    return Response.json({ id });
  };
  sent(): MailPayload[] { return [...this.emails.values()].map(value => JSON.parse(value.payload) as MailPayload); }
}

export async function submit(
  config: Config, provider: FakeProvider, fields: Record<string, string> = validFields(), init: RequestInit = {}, formId = 'contact', customBindings = bindings(),
) {
  const headers = new Headers({
    'Content-Type': 'application/json', Origin: 'https://site.test', 'CF-Connecting-IP': '192.0.2.1',
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const request = new Request('https://forms.test/f/' + formId, { method: 'POST', body: JSON.stringify(fields), ...init, headers });
  const ctx = createExecutionContext();
  const response = await createWorker(config, provider.fetch).fetch(request, customBindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
export async function jobs(): Promise<Delivery[]> {
  return (await env.DB.prepare('SELECT * FROM deliveries ORDER BY channel').all<Delivery>()).results;
}
export async function dueAll() {
  await env.DB.prepare("UPDATE deliveries SET next_at = 0 WHERE status IN ('pending', 'processing')").run();
}
