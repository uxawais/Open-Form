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

## Use Open Form on your website

Open Form runs in **your Cloudflare account**. Each form message is checked by
Turnstile, saved in your private D1 database, and emailed through your Resend
account. You keep your website design; you only point its form to your Open Form
address.

### What you need

- A Cloudflare account (Workers and D1 host the form service and its private records).
- A domain you control, for the website and email setup.
- A Resend account and a verified sending domain (to send notifications and
  optional thank-you emails).
- The website address where the form will appear, for example `https://example.com`.

No paid Open Form account or shared service is involved. Your API keys, database,
messages, and email are yours.

### Setup, step by step

1. **Create your own copy.** Click **Deploy to Cloudflare** at the top of this
   page and follow Cloudflare's prompts, or use the [manual deployment guide](docs/deployment.md).
   This creates the Worker and D1 database in your Cloudflare account. The first
   deployment has all example forms switched off.
2. **Create a Turnstile widget.** In Cloudflare, add the hostname of your website
   (such as `example.com`). Keep both the public **site key** and private **secret
   key**. The site key goes in the website; the secret key goes only in the Worker.
3. **Set up email sending.** In Resend, verify a domain you own and create an API
   key. You will also choose the email address that receives form messages. A
   thank-you email to the visitor is optional.
4. **Add private settings to your Worker.** In your copy of this project, edit
   `config/forms.json`: replace the example website address and email addresses,
   set the Turnstile hostname, and enable `contact`. In Cloudflare, add the Resend
   API key, Turnstile secret key, and the two generated admin/abuse secrets as
   Worker secrets. See [deployment](docs/deployment.md) and
   [configuration](docs/configuration.md) for the exact fields.
5. **Deploy your settings.** Run `npm run deploy` from your project copy, or use
   the deployment method in the guide. Your form URL will look like
   `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/f/contact`.
6. **Connect your website form.** Keep your existing layout and styling. Set its
   endpoint to the URL above and add the Turnstile public site key. The field
   names must match the form configuration (the default contact form uses `name`,
   `email`, and `message`). Examples are below.
7. **Send a real test.** Open your website, complete Turnstile, and submit a test
   message. Check that the form reports success and that the notification arrives
   at your chosen inbox. If thank-you emails are enabled, check the test sender's
   inbox too. See [verification](docs/verification.md).

### Connect a simple HTML form

Replace the Worker URL and public Turnstile site key with your own. Keep the field
names and action the same as your Worker configuration:

~~~html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>

<form action="https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/f/contact" method="POST">
  <label>Name <input name="name" required maxlength="100"></label>
  <label>Email <input type="email" name="email" required maxlength="254"></label>
  <label>Message <textarea name="message" required minlength="5" maxlength="8000"></textarea></label>

  <div class="cf-turnstile" data-sitekey="YOUR-PUBLIC-TURNSTILE-SITE-KEY" data-action="contact"></div>
  <button type="submit">Send message</button>
</form>
~~~

The browser sends the message and Turnstile result to your Worker. For a complete
HTML page, see [`examples/html/contact.html`](examples/html/contact.html).

### Connect a React or Next.js form

Use [`examples/react/ContactForm.tsx`](examples/react/ContactForm.tsx) as a guide.
Pass it your Worker URL and public Turnstile site key. If your website already has
a form, keep its design and adapt the example's submit behavior to send the same
fields. A successful JSON submission returns HTTP `202` with a submission ID.

### Keep these keys private

It is safe for website visitors to see the **Worker URL** and **Turnstile site
key**; they are public settings. Never put any of these in website code, HTML,
GitHub, or a browser request:

- Resend API key
- Turnstile secret key
- `ADMIN_TOKEN`
- `ABUSE_SECRET`

Keep them as Cloudflare Worker secrets. Never copy another project's keys or
email settings; every user configures their own accounts. The public example
configuration is deliberately disabled and contains placeholders.

### Common questions

- **Will it change how my form looks?** No. You can keep your existing design and
  fields; connect its submit action to your Worker.
- **Where do submissions go?** They are stored in your Cloudflare D1 database and
  emailed to the address you set as the notification recipient.
- **Does the visitor get a reply?** Only if you turn on the optional acknowledgment
  email in `config/forms.json`.
- **Can visitors see saved messages?** No. Reading submissions requires the
  private `ADMIN_TOKEN`; it must never be placed in the website.
- **Does Open Form subscribe people to a mailing list?** No. The newsletter form
  collects a request and notifies you; it does not manage marketing subscriptions.
- **What does the free setup allow?** Cloudflare and Resend have their own limits.
  See [current platform limits](docs/platform-limits.md); account quotas may be
  shared with your other projects.

For step-by-step Cloudflare setup, see [deployment](docs/deployment.md). For
troubleshooting, see [the troubleshooting guide](docs/troubleshooting.md).

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
- [Verification](docs/verification.md)
- [API](docs/api.md)
- [Architecture](docs/architecture.md)
- [Platform limits](docs/platform-limits.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Examples](examples/README.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

MIT licensed. This repository is intended to be deployed independently by each user.
