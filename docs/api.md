# API

Production endpoints require HTTPS. Every response has `Cache-Control: no-store`,
an opaque `X-Request-ID`, and safe errors without submitted values.

## POST /f/:formId

An enabled form accepts:

- `application/json` objects containing string values.
- `application/x-www-form-urlencoded`.
- `multipart/form-data` with text fields only.

Include the configured required fields and `cf-turnstile-response`. Tokens come
from a real Turnstile widget on an allowed hostname, with the configured action.
They expire after five minutes and are single-use. JSON does not remove this
verification requirement.

~~~http
POST /f/contact
Origin: https://www.yoursite.com
Content-Type: application/json
Accept: application/json
Idempotency-Key: 68e729ac-f229-4bf1-96a5-f57588c80282

{
  "name": "Ada",
  "email": "ada@visitor.com",
  "message": "Please tell me more.",
  "cf-turnstile-response": "A_TOKEN_FROM_YOUR_LIVE_WIDGET"
}
~~~

The token in this snippet is a placeholder, not a usable verification token.
Browser clients add Origin automatically; do not attempt to set it with JavaScript.
Only explicitly configured clients may omit Origin.

JSON acceptance:

~~~json
{
  "ok": true,
  "id": "0fc59ac4-5dbe-4859-8b85-ff9f18c671c7",
  "duplicate": false
}
~~~

Status is `202` after submission and outbox storage commit. It does not promise
email has arrived. A duplicate returns the same ID with `duplicate: true`.
Honeypot submissions are quietly discarded with `{"ok":true}` and no stored ID.

JSON validation failure:

~~~json
{
  "ok": false,
  "error": {
    "code": "validation_failed",
    "message": "Check the form fields.",
    "fields": { "email": "invalid_email", "message": "required" }
  }
}
~~~

Field codes include `required`, `too_short`, `too_long`, `invalid_characters`,
`invalid_email`, `invalid_option`, `invalid_number`, `out_of_range`, and `unknown_field`.

| Status | Typical meaning |
| --- | --- |
| 200 | HTML confirmation page |
| 202 | JSON submission stored, or honeypot quietly ignored |
| 303 | Configured HTML success/error redirect |
| 400 | Malformed body, invalid field/control key, or failed verification |
| 403 | Disallowed Origin or preflight |
| 404 | Unknown/disabled form |
| 405 | Method other than POST or OPTIONS |
| 409 | Key/token reused with different fields |
| 413 | Byte or field-count limit exceeded |
| 415 | Unsupported content type or content encoding |
| 422 | Field validation failed |
| 429 | Persistent request rate limit; inspect Retry-After |
| 503 | Storage/verification temporarily unavailable or required security configuration absent |

JSON content always receives JSON. URL-encoded/multipart requests receive HTML
when Accept contains `text/html`, and JSON otherwise. HTML errors use an optional
configured redirect with a stable `openforms_error` code; they never include fields
or values in its URL. Without a redirect they receive a readable error page.

## Idempotency

Use a cryptographically random 22–128 character URL-safe key, such as a UUID.
Send it in `Idempotency-Key` or the hidden `_idempotency` field, with identical
values if using both. Keep the key when a response is lost, obtain a fresh
Turnstile token, and retry the **same field values**. Reuse with different fields
returns `409`.

Keys are form-scoped and remembered for up to 24 hours, bounded by submission
retention. Matching content from the same IP is also deduplicated for the
configured short window. All attempts still count toward the request rate limit.
After a `503` from storage or verification, refresh the widget before retrying.

## OPTIONS /f/:formId

An enabled form permits preflight only for an approved exact Origin, POST, and
`Content-Type` / `Idempotency-Key` headers. It grants no credentials, wildcard
origin, admin authorization header, or arbitrary method.

## Private API

Keep your administrator token out of websites and public client bundles.
All endpoints below require:

~~~http
Authorization: Bearer YOUR_ADMIN_TOKEN
~~~

Missing/incorrect tokens receive `401`. These endpoints grant no CORS access,
including to allowed form origins. Unauthenticated callers cannot retrieve fields
using a public receipt ID.

### GET /admin/forms/:formId/submissions

Optional `limit` is 1–50 (default 25). Pass a returned `nextCursor` as the URL-encoded
`cursor` query parameter to get the next page. Form filtering does not require a
form to remain enabled/configured; previously stored data stays retrievable until
its own recorded expiry.

~~~json
{
  "submissions": [{
    "id": "0fc59ac4-5dbe-4859-8b85-ff9f18c671c7",
    "formId": "contact",
    "fields": { "name": "Ada", "email": "ada@visitor.com", "message": "Please tell me more." },
    "createdAt": "2026-10-09T12:00:00.000Z",
    "expiresAt": "2027-01-07T12:00:00.000Z",
    "deliveries": [{
      "id": "c578a7e3-1455-4973-8007-3e8c5915403d",
      "channel": "notification",
      "status": "accepted",
      "attempts": 1,
      "providerId": "4c152b5e-e81a-4824-a6b9-b71b5b1a6c93",
      "errorCode": null,
      "nextAttemptAt": null
    }]
  }],
  "nextCursor": null
}
~~~

Both notification and acknowledgment states are normally included. The API
does not expose frozen outbox payloads. Escape stored values when displaying them
in your own operator tools.

### GET /admin/submissions/:submissionId

Returns one submission object in the same format. Expired/missing IDs return `404`.

### POST /admin/deliveries/:deliveryId/retry

No body required. Requeues only `failed` jobs with no unresolved uncertain attempt,
inside the original retry window, below max attempts, and attached to unexpired
submissions. Returns `202 {"ok":true,"status":"pending"}` or `409 retry_unsafe`.
The original payload/key and attempt count are preserved.

`unknown` jobs require provider-log review and cannot be automatically requeued
through this endpoint. Do not reset their database status blindly.

## GET /health

Returns `{"ok":true,"service":"openforms"}` for liveness. It does not query D1,
verify credentials, or prove email delivery. Disabled form templates can still
return healthy liveness.
