import { HttpError } from './errors.ts';
import type { Bindings, ExternalFetch, FormConfig } from './types.ts';

export async function hasher(secret: string | undefined): Promise<(value: string) => Promise<string>> {
  if (!secret || secret.length < 32 || secret.startsWith('replace-')) {
    throw new HttpError(503, 'server_not_configured', 'The form service is not configured.');
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async value => {
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  };
}

export async function authorize(request: Request, env: Bindings): Promise<void> {
  const token = env.ADMIN_TOKEN;
  const provided = request.headers.get('Authorization') ?? '';
  if (!token || token.length < 32 || token.startsWith('replace-') || provided.length > 1024 || !provided.startsWith('Bearer ')) {
    throw new HttpError(401, 'unauthorized', 'Authentication required.');
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(provided.slice(7)))) {
    throw new HttpError(401, 'unauthorized', 'Authentication required.');
  }
}

export async function verifyTurnstile(
  token: string | undefined, form: FormConfig, env: Bindings, fetcher: ExternalFetch, origin: string | null,
): Promise<void> {
  if (!form.turnstile.enabled) return;
  if (!token || token.length > 2048) throw new HttpError(400, 'verification_failed', 'Complete the spam verification and try again.');
  const secret = env[form.turnstile.secretBinding];
  if (typeof secret !== 'string' || !secret || secret.startsWith('replace-')) throw new HttpError(503, 'server_not_configured', 'The form service is not configured.');
  const testSecrets = ['1x0000000000000000000000000000000AA', '2x0000000000000000000000000000000AA', '3x0000000000000000000000000000000AA'];
  if (env.ENVIRONMENT !== 'development' && testSecrets.includes(secret)) throw new HttpError(503, 'server_not_configured', 'The form service is not configured.');
  let result: unknown;
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, idempotency_key: crypto.randomUUID() }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('upstream');
    const text = await response.text();
    if (text.length > 16384) throw new Error('upstream');
    result = JSON.parse(text);
  } catch {
    throw new HttpError(503, 'verification_unavailable', 'Spam verification is temporarily unavailable.', undefined, 60);
  }
  if (!result || typeof result !== 'object') throw new HttpError(503, 'verification_unavailable', 'Spam verification is temporarily unavailable.');
  const data = result as Record<string, unknown>;
  if (data.success !== true) {
    const errors = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    if (errors.some(code => ['internal-error', 'missing-input-secret', 'invalid-input-secret'].includes(String(code)))) {
      throw new HttpError(503, 'verification_unavailable', 'Spam verification is temporarily unavailable.', undefined, 60);
    }
    throw new HttpError(400, 'verification_failed', 'Complete the spam verification and try again.');
  }
  // Cloudflare's development dummy keys deliberately return dummy metadata.
  const dummy = env.ENVIRONMENT === 'development' && testSecrets.includes(secret);
  if (!dummy && (data.action !== form.turnstile.action || typeof data.hostname !== 'string' ||
      !form.turnstile.hostnames.includes(data.hostname) || (origin && data.hostname !== new URL(origin).hostname))) {
    throw new HttpError(400, 'verification_failed', 'Complete the spam verification and try again.');
  }
}
