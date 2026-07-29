import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages', import.meta.url));

// The integration tests need DATABASE_URL, which lives in the root .env rather than the
// shell. `loadEnv` with an empty prefix reads every key, not just VITE_-prefixed ones.
const env = loadEnv('test', fileURLToPath(new URL('.', import.meta.url)), '');

/**
 * How many database connections one test file may hold.
 *
 * Not a tuning knob — this suite exhausts Postgres without it, and the arithmetic is worth
 * writing down because the symptom looks like flakiness.
 *
 * `pool: 'forks'` below gives every test file its own process, so every file that imports
 * `@switchback/db` builds its own PrismaClient with its own pool. Prisma sizes that pool at
 * `physical cores * 2 + 1` — thirteen on the machine this was found on. Eight files here
 * import the client, which is 104 connections wanted against a `max_connections` of 100,
 * before the dev server and the ingest drain have taken the twenty-odd they hold while
 * anyone is actually working. The run then fails two assertions somewhere in the middle,
 * passes on a retry, and looks like an unreliable test rather than a saturated database.
 *
 * Four, because each of those files drives its database work sequentially — the integration
 * describes are `describe.sequential` — so the pool exists to overlap a query with the
 * transaction bookkeeping around it, not to fan out. Eight files at four is thirty-two,
 * which leaves the dev server and the drain their share and still fits.
 *
 * Set here rather than in `packages/db`, because it is a fact about running seventy test
 * files at once and not about the client. `backgroundPrisma` reads the same variable and
 * honours an explicitly-set limit, which would cap the ingest pool at four too — harmless,
 * since no test touches it, and wrong to inherit anywhere else.
 */
const TEST_POOL_SIZE = 4;

if (env.DATABASE_URL) {
  try {
    const url = new URL(env.DATABASE_URL);
    // An operator who has already pinned it knows something we do not — a PgBouncer in
    // transaction mode, say, which wants a low limit and says so in the URL it hands out.
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(TEST_POOL_SIZE));
    }
    env.DATABASE_URL = url.toString();
  } catch {
    // Unparseable. It is about to fail at connect time with a better message than any
    // this file could raise.
  }
}

export default defineConfig({
  resolve: {
    // Explicit aliases rather than relying on the workspace symlinks. Vite will happily
    // resolve either, but pointing straight at the sources keeps the test run identical
    // whether or not `npm install` has linked the packages yet.
    //
    // Two patterns, both anchored: a bare string alias is a *prefix* match in Vite, which
    // would rewrite `@switchback/api/tokens` to `.../src/index.ts/tokens`. The subpath
    // rule mirrors the `@switchback/*/*` paths in tsconfig.json.
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
    // The database suite opens a connection pool and writes rows. Running files in
    // parallel against one local Postgres is fine, but the db file itself must be
    // sequential within itself — enforced there with `describe.sequential`.
    pool: 'forks',
  },
});
