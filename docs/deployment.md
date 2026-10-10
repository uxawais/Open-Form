# Deployment

OpenForms needs a Cloudflare account with Workers and D1, a Turnstile widget,
and a Resend account with a verified sending domain. None belongs to the project
maintainer. Workers Free is the intended starting point.

## Official Deploy to Cloudflare flow

1. The publisher makes the repository public when ready to distribute it and
   enables the repository's recommended security reporting settings. The README
   button already points to `https://github.com/uxawais/Open-Form`.
2. A user clicks the button, connects their GitHub/Cloudflare accounts, and chooses
   their repository, Worker, and D1 names.
3. Cloudflare detects `wrangler.jsonc`, provisions and binds D1, and replaces its
   placeholder database ID in the user's copied repository.
4. Cloudflare discovers secrets from `.dev.vars.example` and prompts for their
   values. Generate separate random `ADMIN_TOKEN` and `ABUSE_SECRET` values.
5. The deploy command applies migrations to the **DB binding**, then deploys the
   Worker. Binding names work even when the user chooses a different database name.
6. The initial Worker has no enabled form. Configure the user's copied
   `config/forms.json`, enable a form, and deploy that configuration.

Cloudflare documents this resource provisioning and secret discovery in its
[official deployment-button workflow](https://developers.cloudflare.com/workers/platform/deploy-buttons/).
The configuration and deploy command have been checked locally. The dashboard
flow has not been exercised against a live account as part of this build.

The button can provision Worker/D1 infrastructure and bind user-supplied secrets.
It does **not** create a Resend account, verify DNS ownership, create/configure
your Turnstile widget, purchase a domain, or choose your website's form policy.

## Manual CLI setup

~~~sh
npm ci
npx wrangler login
npx wrangler d1 create openforms
~~~

Copy the new database UUID into `wrangler.jsonc`, replacing the all-zero placeholder.
Keep binding `DB`. Keep `ENVIRONMENT` set to `production`. You may choose a unique
Worker name and database name. The placeholder cannot be used for a real CLI deploy.

Create a Turnstile widget in your Cloudflare dashboard:

- Add the hostname of the **website containing the form**, e.g. `www.yoursite.com`.
- Use the widget's public site key in HTML/React.
- Put its secret key into the Worker. A public site key is not the secret key.
- Put the exact returned hostname(s) and each form action into `config/forms.json`.
- Widget registration can cover subdomains; OpenForms still checks exact
  configured hostnames and, when present, matches the request Origin's hostname.

Create your Resend account, verify a domain or sending subdomain by adding the
required DNS records, and obtain a sending API key. Set a `notification.from.email`
on that verified domain. The default `resend.dev` sender can send only to your own
Resend account email and is not suitable for deployed forms.

Generate the two local administrative/hash secrets separately, in a private terminal:

~~~sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
~~~

Set the production secrets interactively; do not put values in command arguments,
the repository, browser code, or `wrangler.jsonc`:

~~~sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ABUSE_SECRET
~~~

Wrangler may create the Worker when setting its first secret. This is an intended
step for the owner running these commands. A form using a separate widget can
reference another secret such as `TURNSTILE_SECRET_FEEDBACK`; set it with the same CLI.

Replace example addresses, allowlisted origins, and Turnstile hostnames in
`config/forms.json`. Enable the desired forms, then:

~~~sh
npm run check
npm run build
npm run deploy
~~~

`deploy` applies remote migrations and publishes the Worker. Unlike `build`,
it changes your Cloudflare account. Review the account, DB binding, and configuration
before running it. Cloudflare's account quotas apply to all Workers on the account.

## Local development

~~~sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev -- --var ENVIRONMENT:development
~~~

Replace `.dev.vars` placeholders. Local settings can use:

- Website origin `http://localhost:8080` for the HTML example or `http://localhost:3000`
  for an existing React/Next.js app.
- Form endpoint `http://localhost:8787/f/contact`.
- The published [Turnstile testing keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
  (e.g. public `1x00000000000000000000AA` and secret
  `1x0000000000000000000000000000000AA`).

Dummy hostname/action metadata is accepted **only** with development mode and one
of Cloudflare's explicit dummy secret keys. Live keys still require matching
hostname/action in local mode. Never publish development mode.

Enable/configure the contact sample and serve the example directory from
`http://localhost:8080`; a browser opening a `file:` URL cannot satisfy its Origin
allowlist. Plain HTML success is a confirmation page unless redirects are configured.

Email delivery is not simulated in development. With a real Resend key it sends
real email. Leave that key unset to inspect stored pending jobs without sending.
Run local scheduled work with Wrangler's `--test-scheduled` option and its
`/__scheduled` endpoint, or use the automated tests.

## Custom domain

The assigned `workers.dev` URL is sufficient. A custom `forms.yoursite.com` domain
is optional; add it through Workers' custom-domain settings. The website containing
the form still needs its own allowed Origin and Turnstile hostname, regardless of
the API's hostname. HTTPS is required in production.

## Verify before opening to visitors

1. Confirm `GET /health` responds; this is liveness, not a remote dependency check.
2. Submit the actual HTML or React example using your real Turnstile widget.
3. Retrieve the submission using `ADMIN_TOKEN` and check both delivery states.
4. Confirm notification and optional thank-you receipt at recipients you control.
5. Confirm an invalid widget token, disallowed Origin, and missing admin token fail.
6. Confirm the Cron Trigger is installed and invoked; trigger changes may take time
   to propagate. Review invocation CPU metrics under realistic bounded payloads.
7. Review quotas, sending domain status, retention, and application/service logs.

No live account resources or emails were created during the local project build.
