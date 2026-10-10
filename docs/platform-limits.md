# Platform limits and cost scope

Official documentation checked on 2026-10-09. Quotas can change; recheck the linked
sources before enabling a deployment. Most allowances are account/team-wide, not
a fresh allowance for every OpenForms form.

| Service | Current free-tier constraint | Design consequence |
| --- | --- | --- |
| Workers | 100,000 requests/day; 10 ms CPU per HTTP or Cron invocation; 128 MB memory | Bounded bodies, native routing, small retry/cleanup batches; monitor deployed CPU |
| Workers/D1 | 50 D1 queries per free Worker invocation | Small fixed-size transactions and retry batches |
| D1 | 5 million rows read/day; 100,000 rows written/day | Indexed queries, persistent rate counters consume quota |
| D1 | 500 MB/database, 5 GB/account, 10 databases/account | Retention and size monitoring matter; this deployment uses one database |
| D1 | Seven-day free Time Travel recovery | Backup retention is separate from application deletion |
| Workers Cron | Five triggers/account | OpenForms uses one every-minute trigger |
| Turnstile | 20 widgets, 10 hostnames/widget, unlimited challenges | Create your own widget; independent form actions can share it |
| Resend Free | 100 emails/day, 3,000/month, three domains | Email generally constrains low-volume deployments first |
| Resend API | Default 10 requests/second per team | Handle 429 responses; actual account allowance can differ |
| Resend idempotency | Keys retained for 24 hours | Maximum 23-hour automatic retry window; uncertain sends require review |
| Queues Free | 10,000 operations/day, 24-hour nonconfigurable message retention | Evaluated; D1 outbox/Cron avoids a second delivery-state service |

Workers network waiting is distinct from CPU time. A slow external fetch still
needs timeouts, but its waiting time is not all charged as executing CPU. Local
runtime tests do not demonstrate that every input remains under the live 10 ms
CPU ceiling.

Normally each submission reserves one email per owner recipient and one optional
acknowledgment. With one owner plus an acknowledgment, the provider's 100/day ceiling
can support at most 50 such sends/day before considering other account activity.
The local defaults (90/day, 2,700/month) leave room rather than claiming the full
provider allocation.

Provider rejections and uncertain attempts retain their local reservation. Retries
use the original reservation and provider idempotency key. Local reservation days
can differ from actual sending days after an outage; Resend's real quota responses
remain authoritative. Both sent and received emails count toward Resend's quotas.
Free daily quotas reset at midnight UTC.

No mandatory paid Worker, Queue, KV, Durable Object, email plan, or other service
is introduced. A sending domain must already be owned or acquired; domain
registration is an external cost. GitHub Actions usage follows GitHub's separate
account/repository rules. Higher traffic may require paid plans or adjusted policy,
and distributed abuse can exhaust free quotas even when submission data is rejected.

## Official sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)
- [Turnstile server verification](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Workers native rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Deploy to Cloudflare workflow](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Resend pricing](https://resend.com/pricing)
- [Resend usage limits](https://resend.com/docs/api-reference/rate-limit)
- [Resend verified domains](https://resend.com/docs/dashboard/domains/introduction)
- [Resend development-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)
- [Resend production access](https://resend.com/docs/knowledge-base/does-resend-require-production-approval)
- [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)

Resend does not require a separate production approval process. DNS verification
of a domain you own is still required to send production mail to arbitrary recipients.
