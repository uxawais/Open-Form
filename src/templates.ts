import type { Config, FormConfig, MailPayload } from './types.ts';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}
function render(template: string, variables: Record<string, string>, html: boolean, fieldsHtml?: string): string {
  return template.replace(/{{([^{}]+)}}/g, (_, key: string) =>
    html && key === 'fields' ? (fieldsHtml ?? '') : html ? escapeHtml(variables[key] ?? '') : (variables[key] ?? ''));
}
function subject(value: string): string { return value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200); }

export function notificationPayload(formId: string, id: string, createdAt: number, fields: Record<string, string>, form: FormConfig): MailPayload {
  const entries = Object.entries(fields);
  const variables = {
    ...fields, formId, submissionId: id, createdAt: new Date(createdAt).toISOString(),
    fields: entries.map(([key, value]) => key + ': ' + value).join('\n\n'),
  };
  const fieldsHtml = '<dl>' + entries.map(([key, value]) => '<dt>' + escapeHtml(key) + '</dt><dd>' + escapeHtml(value).replace(/\n/g, '<br>') + '</dd>').join('') + '</dl>';
  const template = form.notification;
  const replyTo = template.replyTo === 'submitter' ? fields[form.emailField ?? ''] : template.replyTo;
  return {
    from: template.from.name + ' <' + template.from.email + '>',
    to: template.to,
    ...(replyTo ? { reply_to: replyTo } : {}),
    subject: subject(render(template.subject, variables, false)),
    text: render(template.text, variables, false),
    ...(template.html ? { html: render(template.html, variables, true, fieldsHtml) } : {}),
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
  };
}

export function acknowledgmentPayload(
  config: Config, formId: string, id: string, fields: Record<string, string>, form: FormConfig,
): { payload?: MailPayload; reason?: string; recipient?: string } {
  const template = form.acknowledgment;
  if (!template.enabled) return { reason: 'disabled' };
  const recipient = fields[form.emailField ?? ''];
  if (!recipient) return { reason: 'missing_email' };
  const protectedAddresses = new Set(Object.values(config.forms).flatMap(f => [
    f.notification.from.email, ...f.notification.to,
    ...(f.notification.replyTo && f.notification.replyTo !== 'submitter' ? [f.notification.replyTo] : []),
    ...(f.acknowledgment.replyTo ? [f.acknowledgment.replyTo] : []),
  ]));
  if (protectedAddresses.has(recipient)) return { reason: 'loop_prevention' };
  // Never turn a public form into a channel for arbitrary text, links, or markup
  // sent to an unverified third-party address.
  const submittedName = fields[template.nameField ?? ''] ?? '';
  const name = submittedName.length <= 80 && /^[\p{L}\p{M} '\u2019-]+$/u.test(submittedName) ? submittedName : 'there';
  const variables = { name, formId, submissionId: id };
  return {
    recipient,
    payload: {
      from: form.notification.from.name + ' <' + form.notification.from.email + '>',
      to: [recipient],
      ...(template.replyTo ? { reply_to: template.replyTo } : {}),
      subject: subject(render(template.subject ?? '', variables, false)),
      text: render(template.text ?? '', variables, false),
      ...(template.html ? { html: render(template.html, variables, true) } : {}),
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', 'Precedence': 'bulk' },
    },
  };
}
