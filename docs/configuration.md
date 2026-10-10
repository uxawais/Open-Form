# Configuration reference

Edit `config/forms.json` and redeploy. Application TypeScript does not need changes.
`npm run check:config` validates it; deployment and CI run that check. Unknown keys
are rejected to catch misspelled security settings.

## Global settings

| Key | Meaning | Default / bounds |
| --- | --- | --- |
| `version` | Configuration format | `1` |
| `limits.bodyBytes` | Actual streamed request byte limit | 32,768; 1,024–65,536 |
| `limits.fieldCount` | Submitted fields including control fields | 24; 4–32 |
| `limits.emailDaily` | Recipient-cost reservations per UTC day | 90 |
| `limits.emailMonthly` | Recipient-cost reservations per UTC month | 2,700 |
| `delivery.batchSize` | Jobs per Cron invocation | 2; 1–2 |
| `delivery.maxAttempts` | Maximum external send attempts per job | 8; 1–12 |
| `delivery.timeoutMs` | Resend request timeout | 8,000; 1,000–10,000 |
| `delivery.retryWindowHours` | Automatic send window from first attempt | 23; 1–23 |

Budget limits may be raised by an owner with sufficient provider quotas, but doing
so does not upgrade any account. One job addressed to multiple owner recipients
reserves one unit per recipient. First-attempt reservations are conservative:
they remain charged locally even if an API call is rejected. Idempotent retries
do not reserve again. Across a midnight retry, these reservations need not match
the provider's exact daily usage; provider quota responses are also handled.

## Form settings

`forms` maps 1–20 IDs to independent configurations. IDs use lowercase letters,
digits and hyphens, begin with a letter, and are at most 64 characters.

| Key | Meaning |
| --- | --- |
| `enabled` | Accept new submissions; false by default |
| `allowedOrigins` | Exact scheme/hostname/port origins; no paths, wildcard or `null` |
| `allowMissingOrigin` | Explicitly allow clients without Origin; false by default |
| `retentionDays` | Stored submission/job lifetime; 1–365 days |
| `fields` | Allowed field names and validation rules |
| `emailField` | A configured email field used as submitter address |
| `honeypot` | Optional extra control field that must remain empty |
| `turnstile` | Verification policy described below |
| `rateLimit.max` | Attempts per IP per form per fixed window; 1–1,000 |
| `rateLimit.windowSeconds` | Fixed window length; 10–86,400 seconds |
| `duplicateWindowSeconds` | Matching content/IP deduplication; 0–3,600 seconds |
| `notification` | Required owner email configuration |
| `acknowledgment` | Optional controlled thank-you email |
| `redirects` | Optional success/error URLs for HTML responses |

HTTPS origins/redirects are required in production. HTTP loopback URLs are accepted
only when the Worker is explicitly in development mode. Requests without Origin
remain Turnstile-protected when verification is enabled; Origin is not authentication.
Changing `enabled` affects new requests, not already stored email jobs.

## Field rules

All submitted values must be strings, including numbers. Arrays, nested objects,
files, repeated form fields, and unknown field names are rejected.

~~~json
{
  "name": { "type": "text", "required": true, "maxLength": 100 },
  "email": { "type": "email", "required": true, "maxLength": 254 },
  "rating": { "type": "enum", "required": true, "values": ["good", "bad"], "maxLength": 4 },
  "quantity": { "type": "number", "required": false, "min": 1, "max": 10, "maxLength": 2 }
}
~~~

`type` is `text`, `email`, `enum`, or `number`. `maxLength` is required (1–16,000).
`minLength` defaults to zero. Length uses JavaScript UTF-16 code units. Values are
trimmed and line endings normalized. Empty optional fields are omitted.
Email addresses use a deliberately restricted ASCII grammar, are normalized to
lowercase, and need a dotted hostname; quoted/international local parts are unsupported.
Number rules accept finite decimal strings without exponents. Enum choices are exact.

Reserved names include `fields`, `formId`, `submissionId`, `createdAt`, and prototype
keys. Control fields are `cf-turnstile-response`, `_idempotency`, and the configured
honeypot. Do not configure these as normal fields. No arbitrary regex or expression
evaluation is supported, keeping CPU work bounded.

## Turnstile

~~~json
{
  "enabled": true,
  "hostnames": ["www.yoursite.com"],
  "action": "contact",
  "secretBinding": "TURNSTILE_SECRET_KEY"
}
~~~

The default secret binding is `TURNSTILE_SECRET_KEY`; additional bindings must start
with `TURNSTILE_SECRET_`. Use the widget's website hostname and set the same
`data-action` or React action. Server verification checks success, exact hostname,
and exact action; for requests with Origin, the hostname must match that Origin too.
The token is not stored. A temporary HMAC of successful tokens prevents cross-form
reuse even during concurrent requests.

An owner can disable verification for a form, accepting the associated spam risk.
Acknowledgments cannot be enabled without Turnstile and a required email field.

## Notification

~~~json
{
  "from": { "name": "My Website", "email": "forms@mail.yoursite.com" },
  "to": ["owner@yoursite.com"],
  "replyTo": "submitter",
  "subject": "New {{formId}} submission",
  "text": "{{fields}}\n\nSubmission: {{submissionId}}",
  "html": "<h1>New {{formId}} submission</h1>{{fields}}"
}
~~~

Configure 1–5 recipients. Sender addresses must use your verified Resend domain.
The submitter is never used as sender. `replyTo` may be `submitter` when an email
field is configured, or a fixed validated address.

Templates support configured field names, `{{fields}}`, `{{formId}}`,
`{{submissionId}}`, and `{{createdAt}}`. Text is required; HTML is optional.
Submitted values are HTML escaped, and `{{fields}}` becomes an escaped definition
list in HTML. Subject control characters from submitted fields become spaces.

Placeholders are allowed only in HTML text, not tag attributes. Script/style and
other active-content tags are rejected. Templates are trusted owner configuration,
not arbitrary visitor HTML. Rendered payloads are frozen when storing the submission
so retrying uses identical content even if you later change configuration.

Example/test sender addresses are rejected when a form is enabled.

## Acknowledgment

~~~json
{
  "enabled": true,
  "nameField": "name",
  "replyTo": "owner@yoursite.com",
  "subject": "Thanks for contacting us",
  "text": "Hi {{name}},\n\nWe received your message and will reply soon.",
  "html": "<p>Hi {{name}},</p><p>We received your message and will reply soon.</p>"
}
~~~

Only `{{name}}`, `{{formId}}` and `{{submissionId}}` are supported. The greeting
accepts a bounded name containing letters, spaces, apostrophes and hyphens; other
inputs use `there`. Visitor messages and arbitrary links are never echoed to
unverified recipient addresses.

At most one acknowledgment is queued per recipient across all forms in a rolling
24-hour window. Sender, owner-recipient and fixed reply-to addresses are suppressed.
Suppression and auto-response headers reduce loops but cannot cover every mailbox
alias or external autoresponder. Turnstile does not prove ownership of an email
address. Enable acknowledgments only when this bounded unverified-address behavior
fits your website.

## Redirects

~~~json
{
  "success": "https://www.yoursite.com/thanks",
  "error": "https://www.yoursite.com/form-error"
}
~~~

Only HTML requests receive configured 303 redirects. Errors append
`openforms_error` with a stable code, never submitted values. JSON always receives
JSON. Missing redirect settings produce simple HTML confirmation/error pages.
Visitors cannot override redirects using `_redirect` or other submitted fields.
Rejected origins do not receive configured redirects.

## Worker bindings and secrets

| Binding | Purpose |
| --- | --- |
| `DB` | D1 database |
| `ENVIRONMENT` | `production` by default; development is a local-only exception |
| `RESEND_API_KEY` | Your sending API key; missing key pauses queued jobs |
| `TURNSTILE_SECRET_KEY` | Your default widget secret; other named secrets may be used |
| `ADMIN_TOKEN` | Random private API bearer token, at least 32 characters |
| `ABUSE_SECRET` | Different random HMAC secret, at least 32 characters |

Do not use copied `replace-` placeholders. Rotating the Resend key does not change
queued payloads. Rotating `ABUSE_SECRET` resets matching of existing temporary
rate/deduplication hashes and recipient cooldowns; schedule it deliberately.
