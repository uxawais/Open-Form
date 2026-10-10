import { ConfigurationError } from './errors.ts';
import { isEmail } from './validation.ts';
import type { Config, FieldRule, FormConfig, EmailTemplate } from './types.ts';

type Obj = Record<string, unknown>;
function fail(path: string): never { throw new ConfigurationError('Invalid configuration at ' + path); }
function obj(value: unknown, path: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  return value as Obj;
}
function keys(value: Obj, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path + '.' + key);
}
function str(value: unknown, path: string, max = 8192): string {
  if (typeof value !== 'string' || !value.length || value.length > max) fail(path);
  return value;
}
function bool(value: unknown, path: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path);
  return value;
}
function num(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(path);
  return value;
}
function strings(value: unknown, path: string, max: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) fail(path);
  return [...new Set(value.map((v, i) => str(v, path + '.' + i, 254)))];
}
function email(value: unknown, path: string): string {
  const result = str(value, path, 254).toLowerCase();
  if (!isEmail(result)) fail(path);
  return result;
}
export function isLocalhost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
function webUrl(value: unknown, path: string, originOnly = false): string {
  const result = str(value, path, 2048);
  let url: URL;
  try { url = new URL(result); } catch { return fail(path); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost(url.hostname)))) fail(path);
  if (originOnly && url.origin !== result) fail(path);
  return result;
}
function template(value: Obj, path: string, variables: Set<string>): EmailTemplate {
  const result: EmailTemplate = {
    subject: str(value.subject, path + '.subject', 200),
    text: str(value.text, path + '.text'),
    ...(value.html === undefined ? {} : { html: str(value.html, path + '.html') }),
  };
  if (/[\x00-\x1f\x7f]/.test(result.subject)) fail(path + '.subject');
  for (const [kind, content] of Object.entries(result)) {
    if (kind === 'html' && /<\s*(?:script|style|iframe|object|embed|svg|math|base|meta|link)\b/i.test(content)) fail(path + '.html');
    for (const match of content.matchAll(/{{([^{}]+)}}/g)) {
      if (!variables.has(match[1] ?? '')) fail(path + '.' + kind + '.placeholder');
      if (kind === 'html' && content.lastIndexOf('<', match.index) > content.lastIndexOf('>', match.index)) fail(path + '.html.attribute_placeholder');
    }
    if (content.replace(/{{[^{}]+}}/g, '').includes('{{')) fail(path + '.' + kind + '.placeholder');
  }
  return result;
}

export function validateConfig(input: unknown): Config {
  const root = obj(input, 'root');
  keys(root, ['version', 'limits', 'delivery', 'forms'], 'root');
  if (root.version !== 1) fail('version');
  const l = obj(root.limits, 'limits'), d = obj(root.delivery, 'delivery');
  keys(l, ['bodyBytes', 'fieldCount', 'emailDaily', 'emailMonthly'], 'limits');
  keys(d, ['batchSize', 'maxAttempts', 'timeoutMs', 'retryWindowHours'], 'delivery');
  const limits = {
    bodyBytes: num(l.bodyBytes, 'limits.bodyBytes', 1024, 65536),
    fieldCount: num(l.fieldCount, 'limits.fieldCount', 4, 32),
    emailDaily: num(l.emailDaily, 'limits.emailDaily', 1, 100000),
    emailMonthly: num(l.emailMonthly, 'limits.emailMonthly', 1, 1000000),
  };
  const delivery = {
    batchSize: num(d.batchSize, 'delivery.batchSize', 1, 2),
    maxAttempts: num(d.maxAttempts, 'delivery.maxAttempts', 1, 12),
    timeoutMs: num(d.timeoutMs, 'delivery.timeoutMs', 1000, 10000),
    retryWindowHours: num(d.retryWindowHours, 'delivery.retryWindowHours', 1, 23),
  };
  const rawForms = obj(root.forms, 'forms');
  if (!Object.keys(rawForms).length || Object.keys(rawForms).length > 20) fail('forms');
  const forms: Record<string, FormConfig> = Object.create(null) as Record<string, FormConfig>;
  for (const [id, value] of Object.entries(rawForms)) {
    const path = 'forms.' + id;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail(path);
    const f = obj(value, path);
    keys(f, ['enabled', 'allowedOrigins', 'allowMissingOrigin', 'retentionDays', 'fields', 'emailField', 'honeypot', 'turnstile', 'rateLimit', 'duplicateWindowSeconds', 'notification', 'acknowledgment', 'redirects'], path);
    const fields: Record<string, FieldRule> = Object.create(null) as Record<string, FieldRule>;
    const rawFields = obj(f.fields, path + '.fields');
    if (!Object.keys(rawFields).length || Object.keys(rawFields).length > limits.fieldCount - 3) fail(path + '.fields');
    for (const [name, value] of Object.entries(rawFields)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || ['constructor', 'prototype', 'cf-turnstile-response', 'fields', 'formId', 'submissionId', 'createdAt'].includes(name)) fail(path + '.fields.' + name);
      const rule = obj(value, path + '.fields.' + name);
      keys(rule, ['type', 'required', 'minLength', 'maxLength', 'values', 'min', 'max'], path + '.fields.' + name);
      if (!['text', 'email', 'enum', 'number'].includes(String(rule.type))) fail(path + '.fields.' + name + '.type');
      const type = rule.type as FieldRule['type'];
      const maxLength = num(rule.maxLength, path + '.fields.' + name + '.maxLength', 1, 16000);
      const minLength = rule.minLength === undefined ? 0 : num(rule.minLength, path + '.fields.' + name + '.minLength', 0, maxLength);
      const field: FieldRule = { type, required: bool(rule.required, path + '.fields.' + name + '.required'), minLength, maxLength };
      if (type === 'enum') field.values = strings(rule.values, path + '.fields.' + name + '.values', 100);
      else if (rule.values !== undefined) fail(path + '.fields.' + name + '.values');
      for (const bound of ['min', 'max'] as const) {
        if (rule[bound] !== undefined) {
          if (type !== 'number' || typeof rule[bound] !== 'number' || !Number.isFinite(rule[bound])) fail(path + '.fields.' + name + '.' + bound);
          field[bound] = rule[bound];
        }
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail(path + '.fields.' + name);
      fields[name] = field;
    }
    const emailField = f.emailField === undefined ? undefined : str(f.emailField, path + '.emailField', 64);
    if (emailField && fields[emailField]?.type !== 'email') fail(path + '.emailField');
    const honeypot = f.honeypot === undefined ? undefined : str(f.honeypot, path + '.honeypot', 64);
    if (honeypot && (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(honeypot) || Object.hasOwn(fields, honeypot) || ['_idempotency', 'cf-turnstile-response', '__proto__', 'constructor', 'prototype'].includes(honeypot))) fail(path + '.honeypot');
    const ts = obj(f.turnstile, path + '.turnstile');
    keys(ts, ['enabled', 'hostnames', 'action', 'secretBinding'], path + '.turnstile');
    const hostnames = strings(ts.hostnames, path + '.turnstile.hostnames', 20);
    if (hostnames.some(host => !/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(host) || host.includes('..'))) fail(path + '.turnstile.hostnames');
    const action = str(ts.action, path + '.turnstile.action', 32);
    if (!/^[A-Za-z0-9_-]+$/.test(action)) fail(path + '.turnstile.action');
    const secretBinding = ts.secretBinding === undefined ? 'TURNSTILE_SECRET_KEY' : str(ts.secretBinding, path + '.turnstile.secretBinding', 64);
    if (!/^TURNSTILE_SECRET_[A-Z0-9_]+$/.test(secretBinding)) fail(path + '.turnstile.secretBinding');
    const rate = obj(f.rateLimit, path + '.rateLimit');
    keys(rate, ['max', 'windowSeconds'], path + '.rateLimit');
    const n = obj(f.notification, path + '.notification'), from = obj(n.from, path + '.notification.from');
    keys(n, ['from', 'to', 'replyTo', 'subject', 'text', 'html'], path + '.notification');
    keys(from, ['name', 'email'], path + '.notification.from');
    const fromName = str(from.name, path + '.notification.from.name', 80);
    if (/[<>"\x00-\x1f\x7f]/.test(fromName)) fail(path + '.notification.from.name');
    const to = strings(n.to, path + '.notification.to', 5).map(v => email(v, path + '.notification.to'));
    const fromEmail = email(from.email, path + '.notification.from.email');
    const replyTo = n.replyTo === undefined ? undefined : n.replyTo === 'submitter' ? 'submitter' : email(n.replyTo, path + '.notification.replyTo');
    if (replyTo === 'submitter' && !emailField) fail(path + '.notification.replyTo');
    const a = obj(f.acknowledgment, path + '.acknowledgment');
    keys(a, ['enabled', 'nameField', 'replyTo', 'subject', 'text', 'html'], path + '.acknowledgment');
    const ackEnabled = bool(a.enabled, path + '.acknowledgment.enabled');
    const nameField = a.nameField === undefined ? undefined : str(a.nameField, path + '.acknowledgment.nameField', 64);
    if (nameField && fields[nameField]?.type !== 'text') fail(path + '.acknowledgment.nameField');
    const ackReplyTo = a.replyTo === undefined ? undefined : email(a.replyTo, path + '.acknowledgment.replyTo');
    const turnstileEnabled = bool(ts.enabled, path + '.turnstile.enabled', true);
    if (ackEnabled && (!emailField || !fields[emailField]?.required || !turnstileEnabled)) fail(path + '.acknowledgment.requires_turnstile_and_email');
    const r = obj(f.redirects, path + '.redirects');
    keys(r, ['success', 'error'], path + '.redirects');
    const redirects: FormConfig['redirects'] = {};
    for (const kind of ['success', 'error'] as const) if (r[kind] !== undefined) redirects[kind] = webUrl(r[kind], path + '.redirects.' + kind);
    const enabled = bool(f.enabled, path + '.enabled');
    if (enabled && [fromEmail, ...to, ...(ackReplyTo ? [ackReplyTo] : [])].some(v => /@(?:[^@]+\.)?example\.(?:com|net|org)$/.test(v) || v.endsWith('@resend.dev'))) fail(path + '.notification.replace_example_addresses');
    forms[id] = {
      enabled,
      allowedOrigins: strings(f.allowedOrigins, path + '.allowedOrigins', 20).map(v => webUrl(v, path + '.allowedOrigins', true)),
      allowMissingOrigin: bool(f.allowMissingOrigin, path + '.allowMissingOrigin'),
      retentionDays: num(f.retentionDays, path + '.retentionDays', 1, 365),
      fields, emailField, honeypot,
      turnstile: { enabled: turnstileEnabled, hostnames, action, secretBinding },
      rateLimit: { max: num(rate.max, path + '.rateLimit.max', 1, 1000), windowSeconds: num(rate.windowSeconds, path + '.rateLimit.windowSeconds', 10, 86400) },
      duplicateWindowSeconds: num(f.duplicateWindowSeconds, path + '.duplicateWindowSeconds', 0, 3600),
      notification: { ...template(n, path + '.notification', new Set(['formId', 'submissionId', 'createdAt', 'fields', ...Object.keys(fields)])), from: { name: fromName, email: fromEmail }, to, replyTo },
      acknowledgment: {
        enabled: ackEnabled, nameField, replyTo: ackReplyTo,
        ...(a.subject !== undefined || ackEnabled ? template(a, path + '.acknowledgment', new Set(['name', 'formId', 'submissionId'])) : {}),
      },
      redirects,
    };
  }
  return { version: 1, limits, delivery, forms };
}
