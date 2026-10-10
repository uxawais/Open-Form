import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
    },
  })],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
}));
