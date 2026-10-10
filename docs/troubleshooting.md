# Troubleshooting

Use the private API to distinguish stored submissions from email delivery state.
Application logs contain opaque IDs and stable event/error codes, never form
contents, credentials, or arbitrary provider error text.

## Form returns 404

The sample forms are disabled. Configure and enable the desired ID, then redeploy.
Check the exact `/f/<id>` path. IDs are case-sensitive and have no trailing slash.

## Browser Origin or CORS errors

Set the exact website origin, including scheme and development port. A hostname
alone or URL with a path/trailing slash is not an Origin. A `file:` page has an
untrusted `null` origin. HTTP localhost is accepted only in development mode.
Browser fetch must not include admin credentials; only Content-Type and
Idempotency-Key are allowed custom CORS headers.

## Verification fails

Use the widget's public site key in the browser and its secret in the Worker.
Check hostname and action in both places. The hostname is the website containing
the widget, not the API hostname. Tokens expire in five minutes and can be used
only once. Reset the widget after rejection or before retrying an unconfirmed
request. Test keys are rejected in production.

`verification_unavailable` indicates an upstream/secret configuration problem,
not a valid challenge. Requests fail closed; no submission is accepted.

## Validation or body errors

Send only configured fields plus the supported control fields. JSON numbers must
be converted to strings. Files, nested values, repeated URL-encoded fields, and
unknown redirect fields are rejected. Check both byte limits and per-field limits.
For HTML redirects, use `openforms_error` to display a helpful page; do not put
submitted data into redirect URLs.

## Submission stored but email missing

Look at each delivery state:

- `accepted`: Resend returned an ID. Check your Resend logs and recipient's spam
  folder; inbox delivery is not established by this status.
- `pending` with `resend_not_configured`: set your own API key. Cron rechecks it.
- `pending` with `local_email_budget`: the conservative local reservation budget
  is full; the submission remains stored.
- `pending` with `resend_rate_limited` or quota codes: wait for the recorded time
  and confirm your account's shared usage.
- `processing`: a live worker holds a two-minute lease. If it crashed, Cron can
  reclaim after the lease expires.
- `failed`: definite rejection or safe retry limit reached. Check the sending
  domain, sender address and API-key permissions. The private retry endpoint
  accepts only safe jobs inside the original window and under the attempt limit.
- `unknown`: a send may have succeeded. Review Resend logs, recipients, timestamps
  and the job's `openforms/<delivery ID>` request key before taking action. The
  private API deliberately rejects blind retries.
- `skipped`: acknowledgement disabled, recipient cooldown, missing email or loop
  protection. The owner notification has its own independent state.

Changing templates does not alter existing frozen jobs. A wrong address/template
cannot be repaired by changing configuration and expecting an old job to change.
Inspect it privately in D1 and choose a deliberate recovery after provider review;
do not silently rewrite an attempted payload under its old provider key.

## Cron or retention is not running

Confirm the Cron Trigger in the Worker dashboard and check scheduled invocation
logs. Trigger propagation is not immediate. Local development does not run a
production Cron Trigger automatically; use Wrangler's scheduled test support.
The Worker processes only two due jobs and bounded cleanup per invocation.

The API hides expired records and the outbox excludes expired submissions even
when cleanup is delayed. Physical deletion occurs during successful maintenance.
Cloudflare Time Travel/backups and Resend's service retention are independent.

## Database unavailable or quota exhausted

Check D1 metrics, database size, binding UUID, migration history, and daily row
allowances. A transaction failure returns 503 and does not queue email. A valid
stored submission is not rolled back because Resend is down.

The rate limiter also uses D1. Allowed-origin attempts from many IPs can consume
database capacity even when invalid. Reduce exposure/payloads, monitor traffic,
and consider Cloudflare account protections that fit your plan.

## Type generation or tests fail locally

Use Node 24 and `npm ci`. The Workers runtime uses local sockets, so a restricted
development sandbox must permit loopback networking. This does not require access
to your Cloudflare account.

Run `npm run types` after changing bindings/compatibility date. The generated
declaration is checked in. Run `npm run check` and `npm run build`; inspect actual
failures instead of deploying around them.

## Administrative authentication

Use a random token of at least 32 characters, sent as a Bearer header over HTTPS.
Query-string tokens and browser CORS access are unsupported. Missing/placeholder
tokens cannot authenticate. Rotate a leaked token immediately and inspect access
at your account boundary.
