import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus, prisma } from '@switchback/db';
import { INGEST_ZOOM, coverBBox } from '@switchback/geo';
import { BUCKET_CAPACITY, ROUTING_ZOOM, spendIngestBudget } from '@switchback/ingest';
import type { BBox } from '@switchback/core';
import { createContext } from '../src/context';
import { ingestPrincipalFor } from '../src/ingest-principal';
import { appRouter } from '../src/root';
import { createCallerFactory } from '../src/trpc';

/**
 * That the allowance is actually connected to the procedures a caller can reach.
 *
 * `rate-limit.db.test.ts` proves the bucket arithmetic by calling `spendIngestBudget` and
 * `queueTiles` directly, which is one layer below the wiring: with every router passing
 * `principal: null` — the limiter switched off entirely — that file stays green. These tests go
 * through `appRouter`, so they fail if any ingest-facing procedure stops charging a caller.
 *
 * Skipped unless `DATABASE_URL` is local, on the same terms as the ingest suite.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

/** An address owned by this file alone, so its bucket is nobody else's. */
const ADDRESS = '203.0.113.77';

const SECRET = 'test-secret-at-least-thirty-two-characters-long';

/** A small box over open sea, so no other test's tiles overlap it. */
const BBOX: BBox = [-30.05, 40.0, -30.0, 40.05];

/** Two anchors inside `BBOX`, neither freehand, so `/plan` has to ask for the network. */
const ANCHORS = [
  { lng: -30.04, lat: 40.01, freehand: false },
  { lng: -30.01, lat: 40.04, freehand: false },
];

function headersFor(address: string): Headers {
  return new Headers({ 'x-forwarded-for': address });
}

function callerFor(headers: Headers) {
  return createCallerFactory(appRouter)({
    db: prisma,
    user: null,
    headers,
    authMethod: null,
    ingestPrincipal: ingestPrincipalFor(headers, null),
    // No `waitUntil`: the publish kick is background work this test has no opinion about.
  });
}

type Caller = ReturnType<typeof callerFor>;

/** The bucket key the router will charge, derived the same way the request path derives it. */
function principalKey(): string {
  return ingestPrincipalFor(headersFor(ADDRESS), null).key;
}

/** What the caller has left, or `BUCKET_CAPACITY` when no row exists — a missing row is full. */
async function remaining(): Promise<number> {
  const row = await prisma.ingestRateBucket.findUnique({ where: { principal: principalKey() } });
  return row?.tokens ?? BUCKET_CAPACITY;
}

/** Every quadkey either ingest path can touch from `BBOX`, at both zooms. */
function touchedQuadkeys(): string[] {
  return [
    ...coverBBox(BBOX, INGEST_ZOOM, 4096).quadkeys,
    ...coverBBox(BBOX, ROUTING_ZOOM, 4096).quadkeys,
  ];
}

async function clear(): Promise<void> {
  const quadkeys = touchedQuadkeys();
  await prisma.ingestJob.deleteMany({
    where: { OR: quadkeys.map((quadkey) => ({ dedupeKey: { contains: quadkey } })) },
  });
  await prisma.ingestTile.deleteMany({ where: { quadkey: { in: quadkeys } } });
  await prisma.routingTile.deleteMany({ where: { quadkey: { in: quadkeys } } });
  await prisma.ingestRateBucket.deleteMany({ where: { principal: principalKey() } });
}

describe.skipIf(!IS_LOCAL)('the ingest allowance, through the procedures that spend it', () => {
  beforeEach(async () => {
    vi.stubEnv('AUTH_SECRET', SECRET);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await clear();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await clear();
    await prisma.$disconnect();
  });

  it('gives every request context a principal, so no procedure can run without one', async () => {
    const context = await createContext({ headers: headersFor(ADDRESS), db: prisma });

    expect(context.ingestPrincipal).toEqual(ingestPrincipalFor(headersFor(ADDRESS), null));
    expect(context.ingestPrincipal.kind).toBe('address');
  });

  /**
   * Every call site that charges a caller, one test each.
   *
   * Table-driven deliberately. The round-2 mutation switched all five sites off at once, which
   * establishes only that turning *all* of them off is noticed — strictly weaker than "the
   * limiter cannot be switched off unnoticed". Three sites had no test at all, including
   * `coverageFor`, which serves `trails.browse` and `trails.near` and is the path a map hammers.
   * One site dropped in isolation now fails one named test.
   */
  const CHARGED: Array<{
    procedure: string;
    site: string;
    call: (caller: Caller) => Promise<unknown>;
  }> = [
    {
      procedure: 'trails.browse',
      site: 'trails.ts — coverageFor, shared with trails.near',
      call: (caller) => caller.trails.browse({ bbox: BBOX }),
    },
    {
      procedure: 'trails.coverage',
      site: 'trails.ts — the viewport poll',
      call: (caller) => caller.trails.coverage({ bbox: BBOX }),
    },
    {
      procedure: 'trails.fetchArea',
      site: 'trails.ts — the deliberate area fetch',
      call: (caller) => caller.trails.fetchArea({ bbox: BBOX }),
    },
    {
      procedure: 'routes.coverage',
      site: 'routes.ts — the planner map poll',
      call: (caller) => caller.routes.coverage({ bbox: BBOX }),
    },
    {
      procedure: 'routes.plan',
      site: 'routes.ts — planRoute',
      call: (caller) => caller.routes.plan({ anchors: ANCHORS, preferPaths: true }),
    },
  ];

  for (const { procedure, site } of CHARGED) {
    it(`charges the caller through ${procedure} (${site})`, async () => {
      const before = await remaining();

      const entry = CHARGED.find((candidate) => candidate.procedure === procedure);
      await entry?.call(callerFor(headersFor(ADDRESS)));

      expect(await remaining()).toBeLessThan(before);
    });
  }

  it('refuses an area fetch by name once the caller has spent its allowance', async () => {
    await spendIngestBudget(prisma, ingestPrincipalFor(headersFor(ADDRESS), null), BUCKET_CAPACITY);

    const area = await callerFor(headersFor(ADDRESS)).trails.fetchArea({ bbox: BBOX });

    expect(area.busy).toBe(true);
    expect(area.busyReason).toBe('rate-limit');
    expect(
      await prisma.ingestJob.count({
        where: {
          kind: JobKind.ingest_tile,
          status: { in: [JobStatus.queued, JobStatus.running] },
          OR: touchedQuadkeys().map((quadkey) => ({ dedupeKey: { contains: quadkey } })),
        },
      }),
    ).toBe(0);
  });

  it('keeps two callers apart across the procedures, not just inside the bucket', async () => {
    await spendIngestBudget(prisma, ingestPrincipalFor(headersFor(ADDRESS), null), BUCKET_CAPACITY);
    const other = headersFor('198.51.100.88');

    try {
      const refused = await callerFor(headersFor(ADDRESS)).trails.fetchArea({ bbox: BBOX });
      const served = await callerFor(other).trails.fetchArea({ bbox: BBOX });

      expect(refused.busyReason).toBe('rate-limit');
      expect(served.busy).toBe(false);
    } finally {
      await prisma.ingestRateBucket.deleteMany({
        where: { principal: ingestPrincipalFor(other, null).key },
      });
    }
  });
});
