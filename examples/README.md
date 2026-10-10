# Integration examples

Configure and enable contact first. Its allowed origin must exactly match the
website, including scheme and port. Turnstile hostname and action must match the
widget; these examples use action `contact`.

## HTML

Copy `html/contact.html` and replace its action URL and public Turnstile site key.
The widget inserts `cf-turnstile-response` automatically. The example uses URL
encoding and displays the Worker's confirmation page unless a redirect is configured.

For local use, set the action to `http://localhost:8787/f/contact` and serve it from
`http://localhost:8080`. Use development mode and testing keys as documented in
the deployment guide. A directly opened file has an untrusted Origin.

## React and Next.js

Copy `react/ContactForm.tsx` into an existing React 18+ app. React comes from your
application, not the backend. The client directive supports Next.js App Router.

~~~tsx
<ContactForm endpoint="https://forms.example.com/f/contact" siteKey="YOUR-SITE-KEY" />
~~~

The component retains a random idempotency key after a lost response, obtains a
new verification token for retry, and cleans up its widget. Endpoint/site key are
public values; server secrets never belong here.

If an app already loads Turnstile, use `?render=explicit` and adapt the effect to
that app's existing script loader. HTTPS or localhost is required for
`crypto.randomUUID()`.

## Vue, static sites, and server clients

Vue can use the HTML action or the same JSON fetch contract from the API guide.
Submit strings and a valid verification token. Do not send framework metadata,
files, arrays, or visitor-controlled redirect fields.

A server client that omits Origin requires explicit `allowMissingOrigin: true`.
This does not waive a form's Turnstile requirement.
