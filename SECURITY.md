# Security policy

OpenForms treats public form data as untrusted and stored submissions as private.
Version 0.1 is the initial release line; fixes should target the current version.
No response-time or vulnerability-free guarantee is made.

## Report a vulnerability

After publication, use the repository's **Security → Report a vulnerability**
private-reporting feature. Maintainers should enable private vulnerability reporting
before distributing the deployment button.

If that feature is unavailable, open an issue asking for a private reporting
channel without disclosing exploit details or personal data. Do not post secrets,
live submission contents, administrator tokens, or private provider logs.

## Implemented boundaries

- Request byte/field limits and a strict configured field allowlist.
- Parameter-bound SQL and atomic D1 submission/outbox storage.
- Exact origin policy plus verified Turnstile hostname/action and replay records.
- Persistent IP throttles, recipient cooldowns, and conservative sending budgets.
- Fixed verified-domain senders, validated addresses, safe subjects, escaped HTML,
  restricted acknowledgment personalization, and auto-response headers.
- Private constant-time bearer verification, no administrator CORS, no public
  submission content, and no-store responses.
- Immutable email jobs and bounded provider idempotency retries.
- Application logs restricted to stable codes and opaque identifiers.

Origin is not authentication. Turnstile is not proof of email ownership.
Distributed/human spam and quota exhaustion remain possible. Mailbox aliases and
external autoresponders can defeat simple address equality; headers are advisory.
Production CPU performance, live service configuration and inbox delivery must be
verified by the deployment owner.

## Deployment responsibilities

Keep ENVIRONMENT at production, use real widget secrets, verify your sending
domain, keep administrator/HMAC secrets private, restrict provider keys where
practical, maintain dependency updates, and monitor quotas and delivery states.
Never put server secrets into frontend bundles or repository configuration.

D1 data, frozen email payloads and external provider logs can contain personal
information. Choose retention suitable for your site. Application deletion does
not erase provider backups or Resend's independent logs. Any client displaying
retrieved fields must escape them.

See the architecture and deployment guides for failure/recovery behavior.
