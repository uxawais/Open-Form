# OpenForms

A small, self-hosted form backend for Cloudflare Workers and D1. Accept forms from
HTML, React, Next.js, Vue, or a static site, store submissions privately, and send
transactional email through your own Resend account.

Every installation uses its owner's Cloudflare account, database, secrets, and
sending domain. There is no shared service, subscription, registration, dashboard,
or connection to a maintainer's infrastructure.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/uxawais/Open-Form)

**Publishing setup:** Cloudflare's deployment button requires a public repository.
Make this repository public when ready to offer deployment to other developers.
The official flow provisions the Worker and D1 in the deploying user's account.
Turnstile, verified email sending, secrets, and form settings still require setup.
See [deployment](docs/deployment.md).

## Features

- Multiple independent `/f/contact`, `/f/newsletter`, and `/f/feedback` endpoints.
- JSON, URL-encoded HTML, and text-only multipart submissions.
- Required fields, email/number/enum validation, byte and content limits.
- Exact origin allowlists, restricted CORS, and configured HTML redirects.
- Server-verified Turnstile, optional honeypots, persistent rate limiting,
  replay protection, and duplicate suppression.
- Transactional submission/outbox storage and independent notification and
  acknowledgment states.
- Retries with immutable payloads, leases, Resend idempotency, and account budgets.
- Optional personalized thank-you emails with recipient cooldowns and loop controls.
- Authenticated retrieval, cursor pagination, and configurable data retention.
- No runtime packages; TypeScript, Wrangler, Vitest, and Cloudflare's test plugin
  are development dependencies.

## Quick start

Use Node.js 24 (or Node.js 22.18+).

~~~sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev -- --var ENVIRONMENT:development
~~~

All example forms are **disabled**. Edit `config/forms.json` to replace the example
origins, Turnstile hostnames/actions, sender and recipient addresses. Enable the
forms you need. Put local secrets in `.dev.vars`; it is ignored by Git.

Use Cloudflare's published development Turnstile keys only with
`ENVIRONMENT=development`. Production rejects these keys. Local email sending is
real: use your own verified Resend sender and a recipient you control, or omit
`RESEND_API_KEY` to keep jobs queued without sending.

Follow the [deployment guide](docs/deployment.md) to create/bind remote D1, configure
production secrets, verify your sending domain, and activate your own endpoint.
No account resources are created by `npm test` or `npm run build`.

## Connect an HTML form

Replace the URL and public site key, then configure and enable `contact`:

~~~html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form action="https://forms.example.com/f/contact" method="POST">
  <input name="name" required maxlength="100">
  <input type="email" name="email" required maxlength="254">
  <textarea name="message" required minlength="5" maxlength="8000"></textarea>
  <div class="cf-turnstile" data-sitekey="YOUR-SITE-KEY" data-action="contact"></div>
  <button type="submit">Send</button>
</form>
~~~

The complete [HTML example](examples/html/contact.html) waits for verification
before enabling Send. A [React/Next.js component](examples/react/ContactForm.tsx)
includes widget cleanup, JSON requests, and safe lost-response retry keys.

## Development checks

~~~sh
npm run check
npm run build
npm audit
~~~

Tests run inside Cloudflare's local Workers runtime against real local D1
migrations. External APIs are mocked. The build is a Wrangler **dry run**.
See [verification](docs/verification.md) for the validated scope and remaining live
deployment checks.

## Free-tier scope

Low-volume sites can use Workers, D1, Turnstile, and Resend without a mandatory
monthly subscription. A verified sending domain is required; acquiring one may
cost money. Account quotas are shared with your other applications.

Resend Free allows 100 emails/day and 3,000/month. One owner recipient plus a
thank-you email consumes two emails per submission. OpenForms defaults to
conservative reservations of 90/day and 2,700/month. These are local safety
budgets, not a measurement of your provider's total usage.

Workers Free has a 10 ms CPU limit per invocation. Payloads, fields, retry batches,
and cleanup are bounded. Local tests do not establish production CPU performance.
See [current limits and official sources](docs/platform-limits.md).

## Reliability boundaries

A successful API response means the submission and email jobs were stored.
`accepted` means Resend accepted an email, not that it reached an inbox.
Uncertain sends stop for operator review before Resend's 24-hour idempotency
protection expires. There is no unconditional exactly-once or spam-free guarantee.
See [architecture](docs/architecture.md) and [troubleshooting](docs/troubleshooting.md).

Attachments, inbound email, mailing-list management, arbitrary validation regexes,
and a dashboard are outside this MVP. A newsletter form stores requests and
notifies its owner; it does not subscribe anyone to a marketing campaign.

## Documentation and maintenance

- [Deployment](docs/deployment.md)
- [Configuration](docs/configuration.md)
- [API](docs/api.md)
- [Architecture](docs/architecture.md)
- [Platform limits](docs/platform-limits.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Examples](examples/README.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

MIT licensed. This repository is intended to be deployed independently by each user.
