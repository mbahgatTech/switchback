import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@switchback/db';
import { TerrainSource } from '../src/elevate';
import { processTile } from '../src/pipeline';
import type { PipelineDeps } from '../src/pipeline';
import type { OverpassElement, OverpassQuerier } from '../src/overpass';
import { trailEnrichJobKey } from '../src/jobs';
import { flatTile, pngResponse } from './fixtures/terrarium';

/**
 * Trail identity against a real PostGIS.
 *
 * The seam, the merge and the claim race are all decided by SQL and by transaction boundaries,
 * so a fake client cannot see any of them: `ST_LineMerge` returning a MultiLineString and the
 * primary key raising a conflict are the two facts the design rests on. Skipped unless
 * `DATABASE_URL` is local — CI's `gates` job runs a `postgis/postgis:17-3.5` service on 5433
 * and applies `spatial.sql`, so these run there.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

/** The real boundary between `120230203` and `120230212`, the two tiles observed splitting. */
const SEAM_LNG = 12.65625;
const LAT = 46.3;
const WEST = '120230203';
const EAST = '120230212';

/** Every fixture name starts here, and cleanup deletes on the prefix. */
const PREFIX = 'ZZ Ident';
const WAY_IDS = [900_001, 900_002, 900_003, 900_004, 900_005];

/** One way of the fixture chain, spanning `[from, to]` in longitude at a fixed latitude. */
function way(id: number, from: number, to: number, name = `${PREFIX} Ridge`): OverpassElement {
  return {
    type: 'way',
    id,
    tags: { name, highway: 'path', surface: 'dirt' },
    geometry: [
      { lat: LAT, lon: from },
      { lat: LAT, lon: to },
    ],
  };
}

// A single physical trail cut into four consecutive ways. W2 straddles the seam, so Overpass
// returns it whole to both tiles — `buildTileQuery` filters per statement and sets no global
// `[bbox:]`, which is what makes a shared claim possible at all.
const W1 = way(900_001, SEAM_LNG - 0.04, SEAM_LNG - 0.02);
const W2 = way(900_002, SEAM_LNG - 0.02, SEAM_LNG + 0.02);
const W3 = way(900_003, SEAM_LNG + 0.02, SEAM_LNG + 0.04);
const W4 = way(900_004, SEAM_LNG + 0.04, SEAM_LNG + 0.06);

/** Answers the tile query with `elements` and the `is_in` region query with nothing. */
function overpassOf(elements: readonly OverpassElement[]): OverpassQuerier {
  return {
    query: (q: string) => Promise.resolve({ elements: q.includes('is_in(') ? [] : [...elements] }),
  };
}

const terrain = new TerrainSource({
  fetchImpl: () => Promise.resolve(pngResponse(flatTile(1000))),
});

function deps(elements: readonly OverpassElement[], overrides: Partial<PipelineDeps> = {}) {
  return {
    db: prisma,
    overpass: overpassOf(elements),
    terrain,
    enrichWaypoints: false,
    trailIdentity: 'claim',
    ...overrides,
  } satisfies PipelineDeps;
}

async function fixtureTrails() {
  return prisma.trail.findMany({
    where: { name: { startsWith: PREFIX } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      slug: true,
      name: true,
      osmId: true,
      lengthM: true,
      surface: true,
      dogsAllowed: true,
      sourceUpdatedAt: true,
    },
  });
}

async function reset() {
  const doomed = await prisma.trail.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = doomed.map((row) => row.id);
  await prisma.ingestJob.deleteMany({
    where: { dedupeKey: { in: ids.map(trailEnrichJobKey) } },
  });
  await prisma.trail.deleteMany({ where: { id: { in: ids } } });
  await prisma.trailWay.deleteMany({ where: { wayId: { in: WAY_IDS.map(BigInt) } } });
  await prisma.ingestTile.deleteMany({ where: { quadkey: { in: [WEST, EAST] } } });
  await prisma.ingestJob.deleteMany({
    where: { dedupeKey: { in: [`ingest_tile:${WEST}`, `ingest_tile:${EAST}`] } },
  });
  await prisma.user.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

describe.skipIf(!IS_LOCAL).sequential('trail identity across a tile seam', () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it('collapses a trail that two tiles each assembled from a different way subset', async () => {
    await processTile(WEST, deps([W1, W2]));
    await processTile(EAST, deps([W2, W3]));

    const rows = await fixtureTrails();
    expect(rows).toHaveLength(1);
    // The whole chain W1..W3, not one tile's half — the union ran before the stats did.
    expect(rows[0]!.lengthM).toBeGreaterThan(5_500);
  });

  it('reaches the same row whichever tile arrives first', async () => {
    await processTile(EAST, deps([W2, W3]));
    await processTile(WEST, deps([W1, W2]));
    expect(await fixtureTrails()).toHaveLength(1);
  });

  it('fragments into two rows when identity falls back to the OSM id', async () => {
    // The control. `min(wayId)` over each tile's own subset is 900001 west and 900002 east, so
    // the `(osmType, osmId)` upsert cannot see that these are one trail.
    await processTile(WEST, deps([W1, W2], { trailIdentity: 'osm-id' }));
    await processTile(EAST, deps([W2, W3], { trailIdentity: 'osm-id' }));
    expect(await fixtureTrails()).toHaveLength(2);
  });

  it('measures the union, not the sum, of two overlapping halves', async () => {
    // W2 is in both tiles. Splicing the stored arrays would count it twice — the measured
    // 2.79 km mean overstatement on production's fragmented pairs.
    const west = await processTile(WEST, deps([W1, W2]));
    expect(west.trailCount).toBe(1);
    const halfA = (await fixtureTrails())[0]!.lengthM;

    await processTile(EAST, deps([W2, W3]));
    const merged = (await fixtureTrails())[0]!.lengthM;

    const halfB = halfA; // symmetric fixture: W1+W2 and W2+W3 are the same length
    expect(merged).toBeLessThan(halfA + halfB);
    expect(merged).toBeCloseTo((halfA * 4) / 3, -2);
  });

  it('keeps refreshing a way-derived trail after the geometry stops growing', async () => {
    // The union is monotonic, so every re-ingest of a settled trail adds nothing to the line.
    // That must not stop OSM's tags reaching the row, or the staleness sweep does nothing at
    // all for the 47,279 way-derived trails.
    const first = new Date('2026-01-01T00:00:00Z');
    await processTile(WEST, deps([W1, W2], { now: () => first }));
    await processTile(EAST, deps([W2, W3], { now: () => first }));

    const retagged = [W1, W2, W3].map((w) => ({
      ...w,
      tags: { ...w.tags, surface: 'asphalt', dog: 'no' },
    }));
    const later = new Date('2026-03-01T00:00:00Z');
    await processTile(WEST, deps(retagged.slice(0, 2), { now: () => later }));

    const [row] = await fixtureTrails();
    expect(row!.surface).toBe('asphalt');
    expect(row!.dogsAllowed).toBe(false);
    expect(row!.sourceUpdatedAt).toEqual(later);
  });

  it('holds the slug and the id stable across repeated ingests', async () => {
    await processTile(WEST, deps([W1, W2]));
    await processTile(EAST, deps([W2, W3]));
    const before = (await fixtureTrails())[0]!;

    await processTile(WEST, deps([W1, W2]));
    await processTile(EAST, deps([W2, W3]));
    const after = await fixtureTrails();

    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.slug).toBe(before.slug);
    expect(after[0]!.lengthM).toBe(before.lengthM);
  });

  it('produces one row when both tiles commit at once', async () => {
    // Two drainers on one `ingest_jobs` table is the documented operating state, and
    // `COMMIT_CONCURRENCY` is 6 inside each. The claim insert is the only thing serialising them.
    await Promise.all([processTile(WEST, deps([W1, W2])), processTile(EAST, deps([W2, W3]))]);
    expect(await fixtureTrails()).toHaveLength(1);
  });
});

describe.skipIf(!IS_LOCAL).sequential('merging two rows that turned out to be one trail', () => {
  beforeEach(reset);
  afterAll(reset);

  /** Two disjoint halves, then the tile that shows they are one trail. */
  async function fragmentThenBridge() {
    await processTile(WEST, deps([W1, W2]));
    await processTile(EAST, deps([W3, W4]));
    expect(await fixtureTrails()).toHaveLength(2);
    return fixtureTrails();
  }

  it('retires the loser, keeps its geometry, and keeps its slug resolving', async () => {
    const [winner, loser] = await fragmentThenBridge();

    await processTile(WEST, deps([W2, W3]));

    const rows = await fixtureTrails();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(winner!.id);
    // W1 through W4: the loser's half is in the surviving line, not deleted with its row.
    expect(rows[0]!.lengthM).toBeGreaterThan(winner!.lengthM + loser!.lengthM - 100);

    const alias = await prisma.trailSlugAlias.findUnique({
      where: { slug: loser!.slug },
      select: { trailId: true },
    });
    expect(alias?.trailId).toBe(winner!.id);
  });

  /** The line, its extent and its measured length — what a refused merge must leave alone. */
  async function geometryOf(id: string) {
    return prisma.trail.findUniqueOrThrow({
      where: { id },
      select: {
        lengthM: true,
        bboxW: true,
        bboxS: true,
        bboxE: true,
        bboxN: true,
        geometryJson: true,
      },
    });
  }

  /** One person reporting both halves — the collision `canMergeTrails` exists to refuse. */
  async function reviewBothHalves(winnerId: string, loserId: string): Promise<string> {
    const user = await prisma.user.create({ data: { name: `${PREFIX} Reviewer` } });
    await prisma.review.createMany({
      data: [
        { trailId: winnerId, userId: user.id, rating: 5, body: 'north half' },
        { trailId: loserId, userId: user.id, rating: 3, body: 'south half' },
      ],
    });
    return user.id;
  }

  it('refuses the merge rather than delete a review, and leaves both lines untouched', async () => {
    const [winner, loser] = await fragmentThenBridge();
    const before = [await geometryOf(winner!.id), await geometryOf(loser!.id)];
    const userId = await reviewBothHalves(winner!.id, loser!.id);

    await processTile(WEST, deps([W2, W3]));

    /*
     * The union is computed over winner, losers and incoming together, so a refusal that only
     * cancels the retire still leaves the winner holding the loser's line. Every derived value —
     * the profile, `gainM`, `estimatedTimeS`, `routeType`, each waypoint's `distM` — is computed
     * from these coordinates, so the winner would describe ground the loser's own page still
     * describes, and the map would draw it twice.
     */
    expect(await geometryOf(winner!.id)).toEqual(before[0]);
    expect(await geometryOf(loser!.id)).toEqual(before[1]);

    // Nothing a reader wrote is moved or dropped, and the loser keeps answering on its own slug
    // rather than being aliased onto a merge that never happened.
    expect(await prisma.review.count({ where: { userId } })).toBe(2);
    expect(await prisma.trailSlugAlias.findUnique({ where: { slug: loser!.slug } })).toBeNull();
  });

  it('matches what the shipped default does with the same three passes', async () => {
    // The refusal is only safe if it is no worse than the mode it can roll back to. Same fixture
    // under `osm-id`: the bridging assembly is a third row, and neither half is rewritten.
    const [winner, loser] = await fragmentThenBridge();
    const before = [await geometryOf(winner!.id), await geometryOf(loser!.id)];
    await reviewBothHalves(winner!.id, loser!.id);

    await processTile(WEST, deps([W2, W3], { trailIdentity: 'osm-id' }));
    const control = await fixtureTrails();

    await reset();
    const [claimWinner, claimLoser] = await fragmentThenBridge();
    await reviewBothHalves(claimWinner!.id, claimLoser!.id);

    await processTile(WEST, deps([W2, W3]));

    expect(await fixtureTrails()).toHaveLength(control.length);
    expect(await geometryOf(claimWinner!.id)).toEqual(before[0]);
    expect(await geometryOf(claimLoser!.id)).toEqual(before[1]);
  });

  it('moves a review that does not collide, and settles the count it lands on', async () => {
    const [winner, loser] = await fragmentThenBridge();
    const author = await prisma.user.create({ data: { name: `${PREFIX} Author` } });
    await prisma.review.create({
      data: { trailId: loser!.id, userId: author.id, rating: 4, body: 'south half' },
    });

    await processTile(WEST, deps([W2, W3]));

    const rows = await fixtureTrails();
    expect(rows).toHaveLength(1);
    const moved = await prisma.review.findFirst({ where: { userId: author.id } });
    expect(moved?.trailId).toBe(winner!.id);
    const counts = await prisma.trail.findUnique({
      where: { id: winner!.id },
      select: { reviewCount: true, rating: true },
    });
    expect(counts).toEqual({ reviewCount: 1, rating: 4 });
  });
});

describe.skipIf(!IS_LOCAL).sequential('a union that cannot be one line', () => {
  beforeEach(reset);
  afterAll(reset);

  // Branches north from the junction W1 and W2 share, so the two tiles' lines fork rather than
  // join and `ST_LineMerge` returns a MultiLineString.
  const BRANCH: OverpassElement = {
    type: 'way',
    id: 900_005,
    tags: { name: `${PREFIX} Ridge`, highway: 'path' },
    geometry: [
      { lat: LAT, lon: SEAM_LNG - 0.02 },
      { lat: LAT + 0.03, lon: SEAM_LNG - 0.02 },
    ],
  };

  /** Which trail, if any, holds each fixture way. */
  async function claims(): Promise<Record<string, string>> {
    const rows = await prisma.trailWay.findMany({
      where: { wayId: { in: WAY_IDS.map(BigInt) } },
    });
    return Object.fromEntries(rows.map((row) => [row.wayId.toString(), row.trailId]));
  }

  /** The northernmost latitude on a stored line — the fork arm's tip, or its absence. */
  async function northmost(trailId: string): Promise<number> {
    const row = await prisma.trail.findUniqueOrThrow({
      where: { id: trailId },
      select: { geometryJson: true },
    });
    const coords = (row.geometryJson as { coordinates: [number, number][] }).coordinates;
    return Math.max(...coords.map(([, lat]) => lat));
  }

  it('leaves the refused arm its own row, its own line and its own ways', async () => {
    await processTile(WEST, deps([W1, W2]));
    const before = (await fixtureTrails())[0]!;

    await processTile(WEST, deps([W2, BRANCH]));

    /*
     * Two rows, not one. The arm forks off a way the ridge already holds, so no single
     * `geometry(LineString, 4326)` covers both — adopting the ridge would store the ridge's own
     * line back over itself and write the arm nowhere, while claiming the ways it was drawn from.
     * Standing down leaves the corpus fragmented, which is what `osm-id` leaves it as, rather
     * than short of a trail that no later ingest could ever restore.
     */
    const rows = await fixtureTrails();
    expect(rows).toHaveLength(2);

    const winner = rows.find((row) => row.id === before.id);
    const arm = rows.find((row) => row.id !== before.id);
    expect(winner?.lengthM).toBe(before.lengthM);
    expect(arm).toBeDefined();
    expect(arm!.slug).not.toBe(winner!.slug);

    // The arm is reachable, not merely counted: its northern tip is on its own line and on
    // nobody else's.
    expect(await northmost(arm!.id)).toBeCloseTo(LAT + 0.03, 6);
    expect(await northmost(winner!.id)).toBeCloseTo(LAT, 6);

    // The shared way stays with the ridge; the arm's own way goes to the arm. A claim pointing
    // at a trail whose geometry does not contain that way is what makes the loss permanent.
    expect(await claims()).toEqual({
      '900001': winner!.id,
      '900002': winner!.id,
      '900005': arm!.id,
    });
  });

  it('holds that split stable however many times either tile arrives', async () => {
    await processTile(WEST, deps([W1, W2]));
    await processTile(WEST, deps([W2, BRANCH]));
    const first = await fixtureTrails();

    await processTile(WEST, deps([W2, BRANCH]));
    await processTile(WEST, deps([W1, W2]));

    const again = await fixtureTrails();
    expect(again.map((row) => [row.id, row.slug, row.lengthM])).toEqual(
      first.map((row) => [row.id, row.slug, row.lengthM]),
    );
  });

  it('matches what the shipped default does with the same two passes', async () => {
    // The refusal path is only safe if it is no worse than the mode it can roll back to. Same
    // fixture, `osm-id`: two rows, and the same two lines.
    await processTile(WEST, deps([W1, W2], { trailIdentity: 'osm-id' }));
    await processTile(WEST, deps([W2, BRANCH], { trailIdentity: 'osm-id' }));

    const rows = await fixtureTrails();
    expect(rows).toHaveLength(2);
    expect(await northmost(rows[1]!.id)).toBeCloseTo(LAT + 0.03, 6);
  });
});

describe.skipIf(!IS_LOCAL).sequential('what `osm-id` touches', () => {
  beforeEach(reset);
  afterAll(reset);

  it('writes no claim at all, so the table is not a dependency of the default path', async () => {
    /*
     * Vercel Preview runs branch code against the production database and CI's migrate job never
     * runs on a pull request, so a claim written under `osm-id` would throw on a missing relation
     * for every trail — and `processTile` counts those `failed`, then writes the tile `ready`
     * with `fetchedAt`, which reads as covered for the whole TTL.
     */
    await processTile(WEST, deps([W1, W2], { trailIdentity: 'osm-id' }));

    expect(await fixtureTrails()).toHaveLength(1);
    expect(await prisma.trailWay.count({ where: { wayId: { in: WAY_IDS.map(BigInt) } } })).toBe(0);
  });
});

describe.skipIf(!IS_LOCAL).sequential('a slug a retired trail still answers on', () => {
  beforeEach(reset);
  afterAll(reset);

  it('is not handed to a different trail', async () => {
    // `trails.bySlug` reads the trail table first and falls back to the alias, so a squatter on
    // an aliased slug silently redirects a permanent public URL to somebody else's trail.
    const alias = `${PREFIX.toLowerCase().replace(/\s+/g, '-')}-ridge`;
    const held = await prisma.trail.create({
      data: {
        slug: `${alias}-holder`,
        name: `${PREFIX} Holder`,
        osmType: 'way',
        osmId: BigInt(WAY_IDS[4]!),
        quadkey: WEST,
        geometryJson: {
          type: 'LineString',
          coordinates: [
            [SEAM_LNG, LAT],
            [SEAM_LNG + 0.01, LAT],
          ],
        },
        centroidLng: SEAM_LNG,
        centroidLat: LAT,
        bboxW: SEAM_LNG,
        bboxS: LAT,
        bboxE: SEAM_LNG + 0.01,
        bboxN: LAT,
        lengthM: 1,
        gainM: 0,
        lossM: 0,
        minEleM: 0,
        maxEleM: 0,
        estimatedTimeS: 1,
        difficulty: 'easy',
        difficultyScore: 0,
        routeType: 'point_to_point',
      },
      select: { id: true },
    });
    await prisma.trailSlugAlias.create({ data: { slug: alias, trailId: held.id } });

    await processTile(WEST, deps([W1, W2]));

    const [trail] = await prisma.trail.findMany({
      where: { name: `${PREFIX} Ridge` },
      select: { slug: true },
    });
    expect(trail?.slug).toBeDefined();
    expect(trail!.slug).not.toBe(alias);

    const resolved = await prisma.trailSlugAlias.findUnique({ where: { slug: alias } });
    expect(resolved?.trailId).toBe(held.id);
  });
});
