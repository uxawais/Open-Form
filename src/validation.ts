import { HttpError } from './errors.ts';
import type { FormConfig } from './types.ts';

export function isEmail(value: string): boolean {
  if (value.length > 254 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  const parts = value.split('@');
  const local = parts[0], domain = parts[1];
  if (parts.length !== 2 || !local || !domain || local.length > 64 ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+$/.test(local)) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label =>
    label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

export function validateFields(raw: Record<string, string>, form: FormConfig): Record<string, string> {
  const errors: Record<string, string> = Object.create(null) as Record<string, string>;
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const controls = new Set(['cf-turnstile-response', '_idempotency', ...(form.honeypot ? [form.honeypot] : [])]);
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(form.fields, key) && !controls.has(key)) errors[key] = 'unknown_field';
  }
  for (const [key, rule] of Object.entries(form.fields)) {
    const value = (raw[key] ?? '').replace(/\r\n?/g, '\n').trim();
    if (!value && rule.required) errors[key] = 'required';
    else if (!value) continue;
    else if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) errors[key] = 'invalid_characters';
    else if (value.length < rule.minLength) errors[key] = 'too_short';
    else if (value.length > rule.maxLength) errors[key] = 'too_long';
    else if (rule.type === 'email' && !isEmail(value)) errors[key] = 'invalid_email';
    else if (rule.type === 'enum' && !rule.values?.includes(value)) errors[key] = 'invalid_option';
    else if (rule.type === 'number') {
      const number = Number(value);
      if (!/^-?(?:\d+|\d*\.\d+)$/.test(value) || !Number.isFinite(number)) errors[key] = 'invalid_number';
      else if ((rule.min !== undefined && number < rule.min) || (rule.max !== undefined && number > rule.max)) errors[key] = 'out_of_range';
    }
    if (!errors[key]) fields[key] = rule.type === 'email' ? value.toLowerCase() : value;
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', 'Check the form fields.', errors);
  return fields;
}
