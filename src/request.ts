import { HttpError } from './errors.ts';
import { isLocalhost } from './config.ts';
import type { FormConfig } from './types.ts';

export function allowedOrigin(request: Request, form: FormConfig, development: boolean): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) {
    if (form.allowMissingOrigin && request.method !== 'OPTIONS') return null;
    throw new HttpError(403, 'origin_forbidden', 'This origin is not allowed.');
  }
  if (!form.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin_forbidden', 'This origin is not allowed.');
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(development && isLocalhost(url.hostname))) {
    throw new HttpError(403, 'origin_forbidden', 'This origin is not allowed.');
  }
  return origin;
}

export function wantsJson(request: Request): boolean {
  return (request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json') ||
    !(request.headers.get('Accept') ?? '').toLowerCase().includes('text/html');
}

export async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const encoding = request.headers.get('Content-Encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') throw new HttpError(415, 'unsupported_encoding', 'Compressed bodies are not supported.');
  const length = request.headers.get('Content-Length');
  if (length && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_body', 'Invalid request body.');
  if (length && Number(length) > maxBytes) throw new HttpError(413, 'payload_too_large', 'The request body is too large.');
  if (!request.body) throw new HttpError(400, 'invalid_body', 'A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, 'payload_too_large', 'The request body is too large.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_body', 'Invalid request body.');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function parseBody(request: Request, bodyBytes: number, fieldCount: number): Promise<Record<string, string>> {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (!['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'].includes(type ?? '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Use JSON, URL-encoded, or multipart form data.');
  }
  const bytes = await boundedBody(request, bodyBytes);
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const add = (key: string, value: unknown) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new HttpError(400, 'invalid_field_name', 'Invalid field name.');
    }
    if (typeof value !== 'string') throw new HttpError(400, 'invalid_body', 'All fields must be strings. Files are not supported.');
    if (Object.hasOwn(fields, key)) throw new HttpError(400, 'duplicate_field', 'Repeated fields are not supported.');
    fields[key] = value;
    if (Object.keys(fields).length > fieldCount) throw new HttpError(413, 'too_many_fields', 'Too many fields.');
  };
  try {
    if (type === 'multipart/form-data') {
      const data = await new Request(request.url, {
        method: 'POST', headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' }, body: bytes,
      }).formData();
      for (const [key, value] of data) add(key, value);
    } else {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      if (type === 'application/json') {
        const data: unknown = JSON.parse(text);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'invalid_body', 'Use a JSON object with string values.');
        for (const [key, value] of Object.entries(data)) add(key, value);
      } else {
        if (/%(?![0-9a-f]{2})/i.test(text)) throw new HttpError(400, 'invalid_body', 'Invalid form encoding.');
        for (const [key, value] of new URLSearchParams(text)) add(key, value);
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_body', 'Malformed request body.');
  }
  return fields;
}

export function idempotencyKey(request: Request, fields: Record<string, string>): string | undefined {
  const header = request.headers.get('Idempotency-Key') ?? undefined;
  const input = fields._idempotency || undefined;
  if (header && input && header !== input) throw new HttpError(400, 'invalid_idempotency_key', 'Conflicting idempotency keys.');
  const key = header ?? input;
  if (key !== undefined && !/^[A-Za-z0-9_-]{22,128}$/.test(key)) {
    throw new HttpError(400, 'invalid_idempotency_key', 'Use a random idempotency key of 22 to 128 URL-safe characters.');
  }
  return key;
}
