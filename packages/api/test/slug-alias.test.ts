import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCError } from '@trpc/server';
import { Difficulty, Prisma, RouteType, prisma } from '@switchback/db';
import { appRouter } from '../src/root';
import { createCallerFactory } from '../src/trpc';

/**
 * A trail URL is public from the moment ingest first indexes it, which is why `commitTrail`
 * refuses to rewrite `slug` on update. A merge retires one of two such URLs, and
 * `trail_slug_aliases` is the only thing standing between that and a 404 on every inbound link.
 *
 * The read is deliberately *not* gated on `INGEST_TRAIL_IDENTITY`. Rolling that flag back does not
 * un-merge anything — the losing trail row is gone — so a gated read would withdraw every redirect
 * while keeping every merge, leaving readers worse off than if the flag had never been on. The
 * second block below holds the one property the gate used to provide: a database with no
 * `trail_slug_aliases` must still answer 404 rather than 500.
 *
 * The first block needs a database because the fallback is a second `findUnique` against a real
 * relation. Skipped unless `DATABASE_URL` is local; CI's `gates` job runs a PostGIS service.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

const LIVE_SLUG = 'zz-alias-winner';
const RETIRED_SLUG = 'zz-alias-retired';

function callerFor(db: typeof prisma) {
  return createCallerFactory(appRouter)({
    db,
    user: null,
    headers: new Headers(),
    authMethod: null,
  });
}

const caller = callerFor(prisma);

async function reset() {
  await prisma.trail.deleteMany({ where: { slug: LIVE_SLUG } });
  await prisma.trailSlugAlias.deleteMany({ where: { slug: RETIRED_SLUG } });
}

describe.skipIf(!IS_LOCAL).sequential('a retired trail URL', () => {
  beforeEach(async () => {
    // An alias exists only where a merge wrote one, and only `claim` merges.
    vi.stubEnv('INGEST_TRAIL_IDENTITY', 'claim');
    await reset();
    const trail = await prisma.trail.create({
      data: {
        slug: LIVE_SLUG,
        name: 'ZZ Alias Ridge',
        geometryJson: {
          type: 'LineString',
          coordinates: [
            [12.6, 46.3],
            [12.7, 46.3],
          ],
        },
        centroidLng: 12.65,
        centroidLat: 46.3,
        bboxW: 12.6,
        bboxS: 46.3,
        bboxE: 12.7,
        bboxN: 46.3,
        lengthM: 7_700,
        gainM: 0,
        lossM: 0,
        minEleM: 1_000,
        maxEleM: 1_000,
        estimatedTimeS: 6_000,
        difficulty: Difficulty.moderate,
        difficultyScore: 40,
        routeType: RouteType.point_to_point,
      },
    });
    await prisma.trailSlugAlias.create({ data: { slug: RETIRED_SLUG, trailId: trail.id } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it('answers on the slug the merge retired, not a 404', async () => {
    const row = await caller.trails.bySlug({ slug: RETIRED_SLUG });
    expect(row.slug).toBe(LIVE_SLUG);
  });

  it('still answers on the surviving slug', async () => {
    expect((await caller.trails.bySlug({ slug: LIVE_SLUG })).slug).toBe(LIVE_SLUG);
  });

  it('is not found when neither the trail nor an alias exists', async () => {
    await expect(caller.trails.bySlug({ slug: 'zz-alias-never-existed' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<TRPCError>);
  });

  /*
   * The rollback case, and the reason the read is ungated. `INGEST_TRAIL_IDENTITY` back on its
   * default is the state an on-caller reaches by following the runbook; the merge that retired
   * this slug is not undone by it, so the redirect has to survive it too.
   */
  it('still answers after the identity flag is rolled back', async () => {
    vi.stubEnv('INGEST_TRAIL_IDENTITY', 'osm-id');
    expect((await caller.trails.bySlug({ slug: RETIRED_SLUG })).slug).toBe(LIVE_SLUG);
  });

  it('still answers with the identity flag absent entirely', async () => {
    vi.stubEnv('INGEST_TRAIL_IDENTITY', undefined);
    expect((await caller.trails.bySlug({ slug: RETIRED_SLUG })).slug).toBe(LIVE_SLUG);
  });
});

describe('a database with no `trail_slug_aliases`', () => {
  const UNKNOWN = 'zz-no-such-trail-at-all';

  /**
   * `trail_slug_aliases` is in production and in any schema `db push` has touched, but a database
   * that predates it raises P2021 on this read. Counting the reads is what separates "the fallback
   * ran and found nothing" from "the fallback was never attempted".
   */
  function againstAliasFailure(error: Error) {
    let aliasReads = 0;
    const db = {
      trail: { findUnique: () => Promise.resolve(null) },
      trailSlugAlias: {
        findUnique: () => {
          aliasReads += 1;
          return Promise.reject(error);
        },
      },
    };
    return { caller: callerFor(db as unknown as typeof prisma), aliasReads: () => aliasReads };
  }

  const missingTable = () =>
    new Prisma.PrismaClientKnownRequestError('The table does not exist', {
      code: 'P2021',
      clientVersion: 'test',
    });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['osm-id', 'claim'])('is consulted under %s and still 404s, not 500s', async (mode) => {
    vi.stubEnv('INGEST_TRAIL_IDENTITY', mode);
    const { caller: against, aliasReads } = againstAliasFailure(missingTable());

    await expect(against.trails.bySlug({ slug: UNKNOWN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<TRPCError>);
    expect(aliasReads()).toBe(1);
  });

  /*
   * The catch exists for one error and must not swallow the rest. This path is now the fallback
   * for every merged-away URL, so an outage reported as "no such trail" would be invisible in
   * exactly the place a reader is most likely to hit it.
   */
  it('lets a connection failure surface rather than reporting it as not found', async () => {
    const { caller: against } = againstAliasFailure(new Error('Server has closed the connection.'));

    await expect(against.trails.bySlug({ slug: UNKNOWN })).rejects.toThrow(/closed the connection/);
  });
});
