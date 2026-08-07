import { PrismaClient } from '@prisma/client';
import { availableParallelism } from 'node:os';
import { createEntraAdapter, createEntraPool, type EntraPoolSizing } from './entra-client';
import { databaseAuthMode } from './entra-source';

/**
 * Two Prisma clients: one pool for requests, a separate one for background work.
 *
 * Next.js dev-mode hot reloading re-evaluates modules on every edit. Constructing a new
 * PrismaClient each time opens a new connection pool each time, and a small managed Postgres
 * caps connections low enough that a few minutes of editing exhausts it — the failure mode is
 * a sudden "too many connections" that looks like a database outage and is actually the dev
 * server. Stashing the instance on `globalThis`, which survives module re-evaluation, is the
 * standard fix.
 *
 * In production the module is evaluated once and the global is never read.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  backgroundPrisma?: PrismaClient;
};

/**
 * How this process proves who it is to Postgres. Read once — a mode that changed under a
 * running process would leave the two pools authenticating differently.
 */
const AUTH_MODE = databaseAuthMode();

/**
 * Prisma's own default pool size, restated.
 *
 * Prisma derives `cores * 2 + 1` from the connection string, and a driver adapter never sees
 * the connection string. Without this the request pool would silently fall to `pg`'s default
 * of ten.
 */
const requestPoolSize = (): number => availableParallelism() * 2 + 1;

/** Prisma's default `pool_timeout`, restated for the same reason. */
const REQUEST_POOL_TIMEOUT_S = 10;

type PrismaLog = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>['log'];

/**
 * One Prisma client, built the way the configured authentication mode requires.
 *
 * Under Entra the pool parameters cannot travel in the URL: `datasourceUrl` and `adapter` are
 * mutually exclusive, and Prisma reads `connection_limit` and `pool_timeout` off a string the
 * adapter bypasses. They are passed to `pg.Pool` directly instead, which is why both sizes
 * appear twice in this file rather than once.
 */
function createClient(
  sizing: EntraPoolSizing,
  log: PrismaLog,
  datasourceUrl?: string,
): PrismaClient {
  if (AUTH_MODE === 'password') {
    return new PrismaClient({ log, ...(datasourceUrl ? { datasourceUrl } : {}) });
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_AUTH is set to Entra but DATABASE_URL is absent.');
  return new PrismaClient({
    log,
    adapter: createEntraAdapter(createEntraPool(url, sizing, AUTH_MODE)),
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  createClient(
    { max: requestPoolSize(), connectionTimeoutMillis: REQUEST_POOL_TIMEOUT_S * 1_000 },
    process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  );

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * How many connections the ingest may hold. Its own pool, not a share of ours.
 *
 * This number exists because a shared pool was measurably not survivable. Prisma sizes its
 * default pool at roughly `cores * 2 + 1` — thirteen on the machine this was found on — and
 * the ingest's commit fan-out was sized independently at six, holding each connection for
 * the length of a transaction whose ceiling is thirty seconds. One drain was comfortable.
 * But three separate code paths start drains — the trails router's `waitUntil` kick, the
 * routes router's, and the cron — each guarded against starting a *second* of its own kind
 * and none of them aware of the others. Three drains is eighteen commits wanting thirteen
 * connections, and the query that lost was Auth.js's `session.findUnique`, which gives up
 * after ten seconds. The visible symptom was not "the ingest is busy": it was a signed-out
 * header, an empty map, and a `trails.browse` that took ninety-six seconds to return
 * nothing, which reads as a broken product rather than a saturated one.
 *
 * A separate pool rather than a reservation inside the shared one, because a reservation is
 * a discipline every future call site has to remember and a pool is a fact about the
 * process. Background work cannot take a connection request traffic might need, whatever it
 * does, because it is not holding a handle to that pool at all.
 *
 * Ten: six for the commit fan-out — `COMMIT_CONCURRENCY` in `packages/ingest/pipeline.ts`
 * derives itself from this number and leaves the rest — and four for the queue bookkeeping
 * of however many drains are running at once. Raising it costs Postgres backends per server
 * process and buys nothing until the commit gate is raised with it.
 */
export const BACKGROUND_POOL_SIZE = 10;

/**
 * Thirty seconds, against Prisma's default ten.
 *
 * The two pools want opposite things from a wait. A request that cannot get a connection
 * should fail quickly, because someone is watching a spinner and a fast error is a better
 * answer than a slow one. A tile commit should wait, because nobody is watching and the
 * alternative is a failed job and a retry that does the same Overpass query again. Matched
 * to `TRAIL_TX_TIMEOUT_MS`, which is the longest a permit can be held.
 */
const BACKGROUND_POOL_TIMEOUT_S = 30;

/**
 * `DATABASE_URL` with the pool parameters set, unless the operator already set them.
 *
 * Password mode only. Prisma reads `connection_limit` and `pool_timeout` off the connection
 * string and strips them before handing it to Postgres; under a driver adapter it never sees
 * the string at all, which is why `createClient` passes the same two numbers to `pg.Pool`
 * instead. Leaving an explicitly-set value alone matters on a managed database where the
 * ceiling is not ours to choose — PgBouncer in transaction mode wants a low limit and says so
 * in the URL it hands out.
 *
 * A URL that will not parse is passed through untouched. It is about to fail at connect
 * time with a far better message than anything this function could raise.
 */
function backgroundUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(BACKGROUND_POOL_SIZE));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', String(BACKGROUND_POOL_TIMEOUT_S));
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * The client every ingest entry point uses by default.
 *
 * Errors only, in every environment. The request client logs queries in development because
 * a route handler runs a handful of them and reading them is how a slow page gets diagnosed.
 * A drain runs tens of thousands, and the last time this was left on the dev server's log
 * reached ninety-nine thousand lines — at which point the one line that mattered, the
 * connection-pool timeout, was in it and unfindable.
 */
export const backgroundPrisma: PrismaClient =
  globalForPrisma.backgroundPrisma ??
  createClient(
    {
      max: BACKGROUND_POOL_SIZE,
      connectionTimeoutMillis: BACKGROUND_POOL_TIMEOUT_S * 1_000,
    },
    ['error'],
    backgroundUrl(),
  );

if (process.env.NODE_ENV !== 'production') globalForPrisma.backgroundPrisma = backgroundPrisma;

export type { PrismaClient };
