import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LineString, LngLat } from '@switchback/core';
import { lineLengthM } from '@switchback/geo';
import {
  Difficulty,
  RouteType,
  measureTrailLengthM,
  prisma,
  readTrailGeometry,
  refreshTrailSearchVector,
  trailIdsInBBox,
  trailIdsNear,
  writeTrailGeometry,
} from '@switchback/db';

/**
 * Integration tests for the raw-SQL layer.
 *
 * Every other test in this repo is pure. These are not: they need a live Postgres with
 * PostGIS, because the thing under test *is* the SQL. Typecheck cannot tell you that
 * `ST_DWithin` was given a geography on one side and a geometry on the other, or that a
 * column name was written unquoted and silently folded to lowercase — only running it can.
 *
 * Skipped unless DATABASE_URL points somewhere local. That guard is not about CI
 * convenience: these tests insert and delete rows, and pointing them at a hosted database
 * by accident is a class of mistake worth making structurally impossible.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(DATABASE_URL);

/**
 * How long a radius query is allowed to take.
 *
 * Not a performance budget. `trailIdsNear` answers in roughly 180 ms against the 56k trails in
 * this repo's local database, because the query is index-assisted — see the note on the
 * function itself, and `trails_geom_geography_gist` in spatial.sql. Vitest's 5 s default was
 * generous for that, and these two tests still tripped it: for a long time the index did not
 * exist, every call fell through to a sequential scan of the whole table, and one afternoon of
 * ingest was enough to push that scan past the deadline.
 *
 * The ceiling stays, and is set well clear of the honest figure on purpose, because what it
 * guards is the plan rather than the latency. A radius query that has lost its index takes
 * seconds uncontended and tens of seconds under concurrent load; anything this catches is that
 * regression and nothing else.
 */
const RADIUS_QUERY_MS = 30_000;

/** A line running due north from `origin`, `count` points spanning `lengthM`. */
function lineNorth(origin: LngLat, lengthM: number, count: number): LngLat[] {
  const mPerDegLat = 111_320;
  return Array.from({ length: count }, (_, i): LngLat => {
    const t = count === 1 ? 0 : i / (count - 1);
    return [origin[0], origin[1] + (lengthM * t) / mPerDegLat];
  });
}

const ORIGIN: LngLat = [-119.5383, 37.8651];
const TRAIL_LENGTH_M = 4000;
const COORDS = lineNorth(ORIGIN, TRAIL_LENGTH_M, 41);
const GEOMETRY: LineString = { type: 'LineString', coordinates: COORDS };
const MIDPOINT = COORDS[20]!;

const SLUG = 'zz-spatial-integration-fixture';

describe.skipIf(!IS_LOCAL).sequential('spatial helpers', () => {
  let trailId: string;

  beforeAll(async () => {
    await prisma.trail.deleteMany({ where: { slug: SLUG } });

    const trail = await prisma.trail.create({
      data: {
        slug: SLUG,
        name: 'Cathedral Spires Ridge',
        description: 'A test fixture. Granite, switchbacks, and no actual eagles.',
        regionName: 'Yosemite National Park',
        geometryJson: GEOMETRY,
        centroidLng: MIDPOINT[0],
        centroidLat: MIDPOINT[1],
        bboxW: ORIGIN[0],
        bboxS: ORIGIN[1],
        bboxE: ORIGIN[0],
        bboxN: COORDS[COORDS.length - 1]![1],
        lengthM: TRAIL_LENGTH_M,
        gainM: 300,
        lossM: 300,
        minEleM: 1200,
        maxEleM: 1500,
        estimatedTimeS: 5400,
        difficulty: Difficulty.moderate,
        difficultyScore: 63.5,
        routeType: RouteType.out_and_back,
        activityTypes: ['hiking'],
      },
    });
    trailId = trail.id;

    await writeTrailGeometry(prisma, {
      trailId,
      geometry: GEOMETRY,
      centroid: MIDPOINT,
    });
  });

  afterAll(async () => {
    await prisma.trail.deleteMany({ where: { slug: SLUG } });
    await prisma.$disconnect();
  });

  it('writes a geometry PostGIS agrees is a 4326 LineString', async () => {
    const rows = await prisma.$queryRaw<Array<{ type: string; srid: number; npoints: number }>>`
      SELECT ST_GeometryType("geom") AS type,
             ST_SRID("geom")         AS srid,
             ST_NPoints("geom")      AS npoints
        FROM trails WHERE id = ${trailId}
    `;
    expect(rows[0]).toEqual({ type: 'ST_LineString', srid: 4326, npoints: COORDS.length });
  });

  it('agrees with the geo package on length to within the sphere/spheroid gap', async () => {
    // Two independent implementations: haversine on a sphere of mean radius 6 371 km here,
    // Vincenty on the WGS84 spheroid in PostGIS. They are *expected* to differ — the
    // meridional radius of curvature runs from 6 335 km at the equator to 6 400 km at the
    // pole, so the two can legitimately disagree by up to ~0.6%. This fixture is a
    // north-south line at 37.9°, where the spheroid radius is 6 359.5 km and the gap works
    // out to 0.18%; that is the number below, and it is geometry, not error.
    //
    // 0.6% is still a tight net for what this test is actually for: a segment stitched in
    // reverse or vertices left out of order inflates the length by tens of percent.
    const fromPostgis = await measureTrailLengthM(prisma, trailId);
    const fromGeo = lineLengthM(COORDS);
    expect(fromPostgis).not.toBeNull();
    expect(Math.abs(fromPostgis! - fromGeo) / fromGeo).toBeLessThan(0.006);
  });

  it('finds the trail from a viewport that only clips it', async () => {
    // A window over the middle of the line, containing neither endpoint. Containment
    // would miss this; intersection is what we actually want.
    const ids = await trailIdsInBBox(prisma, [
      ORIGIN[0] - 0.01,
      MIDPOINT[1] - 0.001,
      ORIGIN[0] + 0.01,
      MIDPOINT[1] + 0.001,
    ]);
    expect(ids).toContain(trailId);
  });

  it('does not find it from a viewport somewhere else entirely', async () => {
    const ids = await trailIdsInBBox(prisma, [10, 45, 10.1, 45.1]);
    expect(ids).not.toContain(trailId);
  });

  it(
    'measures radius distance from the line, not from the centroid',
    async () => {
      // A point ~500 m east of the trail's northern end. It is ~2 km from the centroid, so
      // a centroid-based distance would put it outside a 1 km radius; the line is 500 m away.
      const north = COORDS[COORDS.length - 1]!;
      const probe: LngLat = [north[0] + 0.00567, north[1]];

      const near = await trailIdsNear(prisma, probe, 1000);
      const hit = near.find((r) => r.id === trailId);
      expect(hit).toBeDefined();
      expect(hit!.distanceM).toBeGreaterThan(400);
      expect(hit!.distanceM).toBeLessThan(600);
    },
    RADIUS_QUERY_MS,
  );

  it(
    'excludes trails outside the radius',
    async () => {
      const far: LngLat = [ORIGIN[0] + 1, ORIGIN[1]];
      const near = await trailIdsNear(prisma, far, 5000);
      expect(near.map((r) => r.id)).not.toContain(trailId);
    },
    RADIUS_QUERY_MS,
  );

  it('reads geometry back as parseable GeoJSON with the original vertices', async () => {
    const rows = await readTrailGeometry(prisma, [trailId]);
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!.geojson) as LineString;
    expect(parsed.type).toBe('LineString');
    expect(parsed.coordinates).toHaveLength(COORDS.length);
    expect(parsed.coordinates[0]![0]).toBeCloseTo(ORIGIN[0], 9);
    expect(parsed.coordinates[0]![1]).toBeCloseTo(ORIGIN[1], 9);
  });

  it('returns nothing for an empty id list rather than building an invalid IN ()', async () => {
    await expect(readTrailGeometry(prisma, [])).resolves.toEqual([]);
  });

  it('builds a search vector that matches on name and on description', async () => {
    const rows = await prisma.$queryRaw<Array<{ byName: boolean; byDescription: boolean }>>`
      SELECT "searchVector" @@ to_tsquery('english', 'cathedral') AS "byName",
             "searchVector" @@ to_tsquery('english', 'granite')   AS "byDescription"
        FROM trails WHERE id = ${trailId}
    `;
    expect(rows[0]).toEqual({ byName: true, byDescription: true });
  });

  it('ranks a name match above a description match', async () => {
    // The whole point of the A/B/C weighting. Without it, a trail whose description
    // mentions "cathedral" would tie with the one actually called Cathedral Spires.
    const rows = await prisma.$queryRaw<Array<{ nameRank: number; descRank: number }>>`
      SELECT ts_rank("searchVector", to_tsquery('english', 'cathedral')) AS "nameRank",
             ts_rank("searchVector", to_tsquery('english', 'granite'))   AS "descRank"
        FROM trails WHERE id = ${trailId}
    `;
    expect(rows[0]!.nameRank).toBeGreaterThan(rows[0]!.descRank);
  });

  it('carries the derived display name, and drops it again when the column is cleared', async () => {
    // What makes "Vesper Peak" find a trail OpenStreetMap calls Headlee Pass Trail. Weight A
    // rather than C, because somebody typing a summit is naming the walk, not describing it.
    // The second half is the reason the vector is rebuilt from the row rather than appended
    // to: clearing `displayName` has to take those lexemes back out.
    const matches = async () => {
      const rows = await prisma.$queryRaw<
        Array<{ hit: boolean; displayRank: number; descRank: number }>
      >`
        SELECT "searchVector" @@ to_tsquery('english', 'vesper')         AS "hit",
               ts_rank("searchVector", to_tsquery('english', 'vesper'))  AS "displayRank",
               ts_rank("searchVector", to_tsquery('english', 'granite')) AS "descRank"
          FROM trails WHERE id = ${trailId}
      `;
      return rows[0]!;
    };

    try {
      await prisma.trail.update({
        where: { id: trailId },
        data: { displayName: 'Vesper Peak via Cathedral Spires Ridge' },
      });
      await refreshTrailSearchVector(prisma, trailId);

      const named = await matches();
      expect(named.hit).toBe(true);
      expect(named.displayRank).toBeGreaterThan(named.descRank);
    } finally {
      await prisma.trail.update({ where: { id: trailId }, data: { displayName: null } });
      await refreshTrailSearchVector(prisma, trailId);
    }

    expect((await matches()).hit).toBe(false);
  });

  it('rejects a rating outside 1–5 at the database, not just in zod', async () => {
    const user = await prisma.user.create({ data: { email: `${SLUG}@example.invalid` } });
    try {
      await expect(
        prisma.review.create({ data: { trailId, userId: user.id, rating: 6 } }),
      ).rejects.toThrow(/reviews_rating_range/);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
