import { escapeHtml } from './templates.ts';
import { wantsJson } from './request.ts';
import type { FormConfig } from './types.ts';
import { HttpError } from './errors.ts';
import { isLocalhost } from './config.ts';

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function page(title: string, message: string, status: number, fields?: Record<string, string>): Response {
  const list = fields ? '<ul>' + Object.entries(fields).map(([key, code]) => '<li>' + escapeHtml(key) + ': ' + escapeHtml(code) + '</li>').join('') + '</ul>' : '';
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><body><h1>' + title + '</h1><p>' + escapeHtml(message) + '</p>' + list + '</body></html>',
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
function redirect(url: string | undefined, development: boolean, error?: string): Response | undefined {
  if (!url) return undefined;
  const target = new URL(url);
  if (target.protocol !== 'https:' && !(development && isLocalhost(target.hostname))) return undefined;
  if (error) target.searchParams.set('openforms_error', error);
  return new Response(null, { status: 303, headers: { Location: target.toString() } });
}
export function success(request: Request, form: FormConfig, development: boolean, id?: string, duplicate = false): Response {
  if (wantsJson(request)) return json({ ok: true, ...(id ? { id, duplicate } : {}) }, 202);
  return redirect(form.redirects.success, development) ?? page('Submission received', 'Thank you. Your submission has been received.', 200);
}
export function failure(request: Request, error: HttpError, form?: FormConfig, development = false): Response {
  let response: Response;
  if (request.method === 'OPTIONS' || wantsJson(request)) response = json({ ok: false, error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }, error.status);
  else response = redirect(form?.redirects.error, development, error.code) ?? page('Submission unsuccessful', error.message, error.status, error.fields);
  if (error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter));
  if (error.status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
  return response;
}
export function secure(response: Response, requestId: string, origin?: string | null): Response {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Request-ID', requestId);
  response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Expose-Headers', 'Retry-After, X-Request-ID');
  }
  response.headers.set('Vary', 'Origin, Accept');
  return response;
}
