import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach } from 'vitest';
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env { TEST_MIGRATIONS: D1Migration[]; }
  }
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM rate_counters'),
    env.DB.prepare('DELETE FROM email_reservations'),
  ]);
});
