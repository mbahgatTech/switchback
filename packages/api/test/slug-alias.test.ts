import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCError } from '@trpc/server';
import { Difficulty, RouteType, prisma } from '@switchback/db';
import { appRouter } from '../src/root';
import { createCallerFactory } from '../src/trpc';

/**
 * A trail URL is public from the moment ingest first indexes it, which is why `commitTrail`
 * refuses to rewrite `slug` on update. A merge retires one of two such URLs, and
 * `trail_slug_aliases` is the only thing standing between that and a 404 on every inbound link.
 *
 * Only a merge writes an alias and only `claim` merges, so the read is gated on the same flag —
 * the second block below holds that gate against a database where the table is absent, which is
 * every database the default path runs against.
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
});

describe('a database with no `trail_slug_aliases`', () => {
  const UNKNOWN = 'zz-no-such-trail-at-all';

  /**
   * Production: `trail_slug_aliases` ships with this branch and `ci.yml` applies the schema only
   * on a push to master, so the relation is absent wherever the default path runs. Counting the
   * reads is what separates a gate from a table that merely happens to answer.
   */
  function againstMissingTable() {
    let aliasReads = 0;
    const db = {
      trail: { findUnique: () => Promise.resolve(null) },
      trailSlugAlias: {
        findUnique: () => {
          aliasReads += 1;
          return Promise.reject(new Error('relation "trail_slug_aliases" does not exist'));
        },
      },
    };
    return { caller: callerFor(db as unknown as typeof prisma), aliasReads: () => aliasReads };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is not consulted under the default mode, so an unknown slug is a 404', async () => {
    vi.stubEnv('INGEST_TRAIL_IDENTITY', 'osm-id');
    const { caller: gated, aliasReads } = againstMissingTable();

    await expect(gated.trails.bySlug({ slug: UNKNOWN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<TRPCError>);
    expect(aliasReads()).toBe(0);
  });

  it('is consulted under `claim`, which is what the gate is holding back', async () => {
    vi.stubEnv('INGEST_TRAIL_IDENTITY', 'claim');
    const { caller: ungated, aliasReads } = againstMissingTable();

    // The 500 the gate exists to prevent: without it this is what every 404 returns.
    await expect(ungated.trails.bySlug({ slug: UNKNOWN })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    } satisfies Partial<TRPCError>);
    expect(aliasReads()).toBe(1);
  });
});
