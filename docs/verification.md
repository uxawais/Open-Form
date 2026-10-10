# Verification record

Local checks completed on 2026-10-10. No live resources were deployed and no real
emails were sent during verification. The repository had not yet been pushed
when these local checks were recorded.

## Executed checks

| Check | Result |
| --- | --- |
| Configuration validation | Passed; all three sample forms are deliberately disabled |
| Source and test TypeScript checks | Passed with strict settings |
| Vitest in Cloudflare's local Workers runtime | 68 tests passed across three files |
| D1 migrations | Applied in local D1; Wrangler reports no outstanding migrations |
| Wrangler deployment dry run | Passed; 55.99 KiB bundle, 14.58 KiB gzip |
| npm dependency audit | Zero known vulnerabilities reported |
| React example | Strict TypeScript check passed using temporary React 19 type declarations |

The Node.js version was 24.19.0. Development dependencies are pinned in
`package-lock.json`. React type declarations were used outside the project for
checking the example; React is not a Worker dependency.

## Automated coverage

Tests apply the real D1 migration and exercise the Worker with Cloudflare's local
runtime, including concurrent requests and real SQL constraints. Only external
Turnstile and Resend HTTP responses are mocked.

- Valid JSON, URL-encoded, and text-only multipart submissions, HTML redirects,
  JSON receipts, and independently configured forms.
- Missing required fields, invalid email and field values, malformed bodies,
  unsupported content, repeated fields, files, byte limits, and invalid UTF-8.
- Exact Origin/CORS restrictions, production HTTPS, methods, admin authorization,
  hostname/action verification, invalid Turnstile tokens, and development-key isolation.
- Honeypots, persistent atomic rate counters, duplicate/replay handling,
  concurrent submission races, and idempotency keys reused with different data.
- Escaped email templates, fixed senders, acknowledgment suppression/cooldowns,
  safe subjects, local email budgets, and logs without form contents.
- Atomic database failure recovery, independent delivery states, Resend failures
  and 429 responses, lease recovery, and safe retries after lost responses or a
  database failure after provider acceptance.
- Expired submissions, retention cleanup, bounded retry windows, and refusal to
  retry uncertain sends after the provider's idempotency protection can expire.

Database fault tests use SQL triggers to force failures in real local D1. The
mock email provider models idempotency so the suite checks recovery without
duplicating acknowledgments, rather than merely assuming a successful fetch.

## Remaining owner verification

The [deployment guide](deployment.md) lists the steps to verify the actual HTML
or React form, real Turnstile widget, verified Resend domain, recipient inboxes,
Cron Trigger, and private administrative retrieval after deployment.

The official deployment-button resource workflow was checked against Cloudflare
documentation, but the live dashboard flow was not executed. The README deployment
button points to `uxawais/Open-Form`; distributing this template through the button
requires a public repository. Hosted GitHub Actions results appear in the
repository's Actions tab after pushing; the checks above describe local execution.

Browser widget behavior and inbox delivery have not been validated with live
providers. Local Workers tests and a dry-run build do not establish production
CPU usage under Workers Free's 10 ms ceiling. Measure it on the owner's deployment
with realistic maximum-size submissions and Cron work.

`accepted` records Resend's acceptance, not inbox delivery. Automatic retries stop
within the configured maximum 23-hour window; ambiguous sends require operator
review. No unconditional exactly-once, spam-free, or externally audited security
guarantee is claimed. See [architecture](architecture.md) and
[platform limits](platform-limits.md) for the operational boundaries.
