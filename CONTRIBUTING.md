# Contributing

Use Node.js 24, install with `npm ci`, and keep changes focused on the form backend.

~~~sh
npm run check
npm run build
npm audit
~~~

Tests use Cloudflare's local Workers runtime, real D1 migrations, and controlled
external API doubles. No live account or email credentials are required.

Preserve transaction boundaries, stable error codes, private-data logging rules,
immutable attempted email payloads and the 23-hour maximum retry window. Add tests
for changed security or reliability behavior, including concurrent/failure paths.
Do not weaken validation to make a mock pass.

Prefer web-standard/Cloudflare-native APIs and no new runtime dependencies.
Discuss architecture or infrastructure changes before introducing them. Dashboards,
accounts, billing, arbitrary scripting, and centralized services are outside scope.

Database changes need a new numbered SQL migration and corresponding tests.
Do not edit an already released migration. Configuration changes need validation
and reference documentation. Run `npm run types` after binding/runtime changes.

Before requesting review, explain the concrete behavior change, its reason, and
checks actually executed. Never claim unrun tests passed. Do not include secrets,
real form contents, deployment credentials, or private logs in fixtures or reports.
Use the security policy for vulnerabilities.

Publishing, deployment and account operations are the deployment owner's decisions.
The CI workflow checks changes; it does not deploy them.
