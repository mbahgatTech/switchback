import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages', import.meta.url));

// The integration tests need DATABASE_URL, which lives in the root .env rather than the
// shell. `loadEnv` with an empty prefix reads every key, not just VITE_-prefixed ones.
const env = loadEnv('test', fileURLToPath(new URL('.', import.meta.url)), '');

/**
 * Database connections one test file may hold. Not a tuning knob: `pool: 'forks'` gives each
 * file its own PrismaClient, which defaults to `cores * 2 + 1`, and the eight files importing
 * the client then want more than `max_connections` — the run fails mid-way and looks flaky.
 * Set here rather than in `packages/db` because it is a fact about the test run, not the client.
 */
const TEST_POOL_SIZE = 4;

if (env.DATABASE_URL) {
  try {
    const url = new URL(env.DATABASE_URL);
    // An operator who pinned it already knows something we do not — a PgBouncer in
    // transaction mode, say.
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(TEST_POOL_SIZE));
    }
    env.DATABASE_URL = url.toString();
  } catch {
    // Unparseable: it is about to fail at connect time with a better message than this.
  }
}

export default defineConfig({
  resolve: {
    // Explicit aliases rather than the workspace symlinks, so the run is identical whether or
    // not `npm install` has linked the packages. Both patterns are anchored: a bare string
    // alias is a *prefix* match in Vite, which would rewrite `@switchback/api/tokens` to
    // `.../src/index.ts/tokens`.
    alias: [
      {
        find: /^@switchback\/(core|geo|db|api|ui|weather|busyness|ingest)$/,
        replacement: `${packagesDir}/$1/src/index.ts`,
      },
      {
        find: /^@switchback\/(core|geo|db|api|ui|weather|busyness|ingest)\/(.*)$/,
        replacement: `${packagesDir}/$1/src/$2`,
      },
    ],
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    env,
    // The db file must stay sequential within itself — enforced there with `describe.sequential`.
    pool: 'forks',
  },
});
