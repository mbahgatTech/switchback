import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TileStatus, prisma } from '@switchback/db';
import { quadkeyToBBox, quadkeyToTile } from '@switchback/geo';
import type { BBox } from '@switchback/core';
import { surveyArea } from '../src/coverage';
import { TILE_TTL_MS } from '../src/freshness';

/**
 * Freshness against a real Postgres.
 *
 * The unit tests pin what `isTileFresh` decides once it holds a row. They cannot pin that the
 * row arrives holding `sourceSnapshotAt` at all: every caller names its columns in a Prisma
 * `select`, the in-memory fakes elsewhere in this suite return whatever the fixture literal
 * holds regardless of what was selected, and a `select` that omits the column would leave the
 * predicate reading `undefined` and silently answering the old, weaker question. Only a real
 * query proves the column survives the round trip.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

/** A quadkey namespace owned by this file alone, so the cleanup can delete by name. */
const NS = '301';

/** Fetched a moment ago from a source whose data was current. Genuinely fresh. */
const CURRENT = `${NS}000000`;
/** Fetched a moment ago from a source whose data was already past the TTL. The lie. */
const STALE_SOURCE = `${NS}000001`;
/** Fetched a moment ago, with no source stamp at all — every row predating the column. */
const UNSTAMPED = `${NS}000002`;

const FIXTURES = [CURRENT, STALE_SOURCE, UNSTAMPED];

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/**
 * A bbox that covers this tile and cannot spill into its neighbours. The tile's own bbox shares
 * all four edges with them, and the cover is taken from the centre outwards, so a pinpoint box
 * at the centre is what selects exactly one quadkey.
 */
function centreOf(quadkey: string): BBox {
  const [w, s, e, n] = quadkeyToBBox(quadkey);
  const [lng, lat] = [(w + e) / 2, (s + n) / 2];
  return [lng - 1e-6, lat - 1e-6, lng + 1e-6, lat + 1e-6];
}

async function seedTile(quadkey: string, sourceSnapshotAt: Date | null): Promise<void> {
  const { x, y, z } = quadkeyToTile(quadkey);
  const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(quadkey);
  await prisma.ingestTile.create({
    data: {
      quadkey,
      x,
      y,
      z,
      status: TileStatus.ready,
      bboxW,
      bboxS,
      bboxE,
      bboxN,
      trailCount: 1,
      // The fetch is always recent. Whatever these tiles are judged on, it is not this.
      fetchedAt: NOW,
      sourceSnapshotAt,
    },
  });
}

const cleanup = () => prisma.ingestTile.deleteMany({ where: { quadkey: { in: FIXTURES } } });

describe.runIf(IS_LOCAL).sequential('freshness against a real database', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTile(CURRENT, ago(TILE_TTL_MS - 86_400_000));
    await seedTile(STALE_SOURCE, ago(TILE_TTL_MS + 86_400_000));
    await seedTile(UNSTAMPED, null);
  });

  afterAll(cleanup);

  it('does not report a tile fresh when the source data behind it is past the TTL', async () => {
    const survey = await surveyArea(centreOf(STALE_SOURCE), { db: prisma, now: NOW, maxTiles: 4 });

    expect(survey.quadkeys).toContain(STALE_SOURCE);
    expect(survey.fresh).not.toContain(STALE_SOURCE);
    expect(survey.outstanding).toContain(STALE_SOURCE);
  });

  it('still reports a tile fresh when the source data behind it is inside the TTL', async () => {
    const survey = await surveyArea(centreOf(CURRENT), { db: prisma, now: NOW, maxTiles: 4 });

    expect(survey.fresh).toContain(CURRENT);
  });

  it('serves a row that predates the column on its fetch time alone', async () => {
    const survey = await surveyArea(centreOf(UNSTAMPED), { db: prisma, now: NOW, maxTiles: 4 });

    expect(survey.fresh).toContain(UNSTAMPED);
  });
});
