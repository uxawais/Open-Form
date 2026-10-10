# Architecture

OpenForms is a single module Worker using web-standard routing, D1, and Resend.
Its only persistent dependency is the deploying owner's D1 database. One
every-minute Cron Trigger recovers email work and expires stored data.

## Submission lifecycle

1. Resolve an enabled form and check HTTPS, method, and exact Origin policy.
2. Atomically consume the per-form IP rate bucket in D1.
3. Read bounded bytes, parse supported media, check the honeypot, and validate
   the field allowlist, types, lengths and required values.
4. Resolve an existing valid idempotency/content receipt if present.
5. Verify Turnstile through Siteverify, matching hostname and form action.
6. In one D1 `batch` transaction, store the submission, deduplication records,
   notification job, acknowledgment state, and any recipient cooldown.
7. Return an acceptance response only after that transaction succeeds.
8. Try the two jobs using `waitUntil`. Cron remains the durable recovery mechanism.

Cloudflare documents D1 batch rollback semantics in the
[D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
If any insert fails, neither submission nor email jobs is committed. Email never
runs before this storage commit. Request retries can recover a stored receipt
after a lost response without triggering a new send.

## Tables

| Table | Contents |
| --- | --- |
| `submissions` | Opaque ID, form ID, normalized fields, created/expiry times |
| `deliveries` | One state per channel, frozen payload, attempts, lease, provider ID |
| `dedupe` | Expiring HMAC keys, payload hash and private submission pointer |
| `rate_counters` | Temporary HMAC IP buckets and recipient cooldowns |
| `email_reservations` | Anonymous daily/monthly recipient-cost reservations |

No raw IP, user agent, referrer, Turnstile token or arbitrary request headers are
stored. Submission fields and outgoing email snapshots contain personal data.
Snapshots are needed to replay the exact same provider request. Skipped
acknowledgments retain no redundant email payload.

Indexed queries cover form pagination, due jobs, expirations and budget periods.
Deleting a submission cascades its jobs and deduplication records. Anonymous budget
reservations intentionally survive deletion until the next month plus a day;
otherwise shortening retention could incorrectly reset email limits.

## Delivery states

| State | Meaning |
| --- | --- |
| `pending` | Stored and scheduled; may be paused for quotas or missing credentials |
| `processing` | Claimed with a 120-second lease; another worker cannot claim it yet |
| `accepted` | Resend returned an email ID and that ID was persisted |
| `failed` | Definite rejection or safe retry limit reached |
| `unknown` | May have been accepted, but the result cannot be established safely |
| `skipped` | Acknowledgment disabled, suppressed, missing email, or on cooldown |

Notification and acknowledgment state are independent. Provider acceptance is
not inbox delivery; this version does not consume delivery/bounce webhooks.

## Retry safety

Each job has an immutable serialized payload and `openforms/<delivery UUID>`
provider idempotency key. Before sending, D1 reserves a local budget slot, records
the first-attempt time, increments attempts, and marks the result as potentially
uncertain. This ordering covers a crash after the external API call.

Network errors, malformed successes and server errors are uncertain. Definite
rejections do not erase an earlier uncertain attempt. Retryable errors use bounded
exponential backoff with jitter, `Retry-After`, and UTC quota reset times. Missing
API keys pause jobs without consuming send attempts.

If Resend succeeds but the final D1 update fails, the leased job is reclaimed
after expiry and sent again with the same key/payload. Tests exercise this crash
window against actual local D1 using a failing SQL trigger.

Resend keeps keys for [24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys).
OpenForms caps automatic attempts to a maximum of 23 hours from the first attempt,
leaving a margin. Uncertain jobs stop as `unknown` rather than being blindly sent
after deduplication protection expires. Definitive failures can be requeued through
the private API only while still inside the safe window and below max attempts.
Attempt counters are retained.

This is durable, at-least-once job processing with provider-assisted duplicate
suppression. There is no transaction spanning D1 and Resend, so unconditional
exactly-once email delivery is not claimed.

## Duplicate and replay behavior

Client keys are random 22–128 character URL-safe strings scoped to a form. They
bind to a canonical field/origin hash for up to 24 hours or until the submission
expires. Reuse with changed data fails. The React example preserves keys after
lost responses.

A configurable short content/IP window handles double-clicks without a client key.
Temporary successful-token hashes prevent a token from being reused for changed
fields or another form. Cloudflare also makes live Turnstile tokens single-use.
The raw token is never stored. Duplicate detection returns an opaque receipt,
not the stored fields. Duplicate attempts still count toward request limits.

## Why D1 rate counters and Cron

Cloudflare's native rate binding is local to a Cloudflare location and is
[permissive/eventually consistent](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
Atomic D1 counters support independently configured form limits and consistent
recipient/email budgets without a separate storage service. The tradeoff is
database work for permitted-origin requests and quota exposure under abuse.

Queues is now available on Workers Free with 10,000 operations/day, but free
retention is only 24 hours. A D1 outbox is still needed to retain recoverable state.
For low-volume forms, a small Cron sweep is simpler than maintaining both systems.
It does not promise immediate retry during outages.

Cron processes at most two jobs and bounded indexed cleanup batches. Responses,
due work and retrieval all exclude expired submissions even before physical
cleanup catches up. Platform backups and Resend's own retention are separate.

## Trust boundary

Form settings and HTML templates are owner-controlled trusted configuration.
Public request values are validated and escaped. Administrator tokens stay on
the server/operator client and never grant public browser CORS access.

Turnstile, origin policy, rate counters, cooldowns, and budgets reduce abuse;
they do not prove email ownership or stop every human spammer, distributed bot,
or attack that exhausts free account quotas. Operators should monitor their
provider accounts and invocation metrics.
