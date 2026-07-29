import type { BBox, LngLat, LineString } from '@switchback/core';
import { Prisma } from '@prisma/client';
import type { prisma } from './client';

/**
 * Raw-SQL access to the PostGIS columns.
 *
 * Prisma cannot see `Unsupported` columns at all, so every read and write of geometry
 * goes through this module. Keeping them here rather than scattered through routers has
 * a second benefit beyond tidiness: these are the only places in the codebase that
 * interpolate into SQL, so the places to audit for injection are this file and nowhere
 * else. Every one of them uses tagged templates, which parameterise rather than
 * concatenate — `${bbox[0]}` becomes `$1`, not text.
 */

/** Accepts the client or a transaction client, so callers can compose. */
export type Db = Pick<typeof prisma, '$executeRaw' | '$queryRaw'> | Prisma.TransactionClient;

export interface TrailGeometryInput {
  trailId: string;
  /** Full-resolution line. The simplified copy is stored separately as `geometryJson`. */
  geometry: LineString;
  centroid: LngLat;
  /** Trail name — weighted highest in the search vector. */
  name: string;
  regionName?: string | null;
  description?: string | null;
}

/**
 * Write a trail's geometry, centroid, and search vector.
 *
 * Called immediately after `trail.create()` inside the same transaction. The three
 * columns are written together because they are all derived from the same source line,
 * and a row with geometry but no search vector would be invisible to search while
 * appearing on the map — a discrepancy that is very hard to notice and very confusing.
 *
 * Search weights: name (A) beats region (B) beats description (C). A trail literally
 * called "Eagle Peak" should outrank one whose description mentions eagles.
 */
export async function writeTrailGeometry(db: Db, input: TrailGeometryInput): Promise<void> {
  const geojson = JSON.stringify(input.geometry);
  await db.$executeRaw`
    UPDATE trails SET
      "geom"     = ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326),
      "centroid" = ST_SetSRID(ST_MakePoint(${input.centroid[0]}, ${input.centroid[1]}), 4326),
      "searchVector" =
          setweight(to_tsvector('english', ${input.name}), 'A')
       || setweight(to_tsvector('english', ${input.regionName ?? ''}), 'B')
       || setweight(to_tsvector('english', ${input.description ?? ''}), 'C')
    WHERE id = ${input.trailId}
  `;
}

/**
 * Give every one of a trail's waypoints its PostGIS point, in one statement.
 *
 * The coordinates are not passed in, because they are already on the rows: `lng` and `lat`
 * are ordinary columns Prisma wrote a moment ago, and `point` is the same pair in a form
 * Prisma cannot express. So this is a projection of a row onto itself rather than a load of
 * data from the caller, which is why it needs neither ids nor a matching array nor any
 * assumption about the order rows came back in.
 *
 * That property is the point. This replaced a loop that created one waypoint and then wrote
 * one point, two round-trips each, inside the trail's transaction — so a trail with forty
 * waypoints spent eighty sequential round-trips there, and the transaction's 30 s ceiling was
 * reached by nothing more exotic than arithmetic. Under a drain committing six trails at once
 * against a Node process synchronously decoding terrain PNGs, every one of those round-trips
 * waits on a blocked event loop, and the ceiling arrives much sooner than eighty round-trips
 * of honest latency would suggest. One statement removes the multiplier rather than raising
 * the ceiling, which is the difference between a fix and a deferral.
 */
export async function writeWaypointPoints(db: Db, trailId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE waypoints
       SET "point" = ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)
     WHERE "trailId" = ${trailId}
  `;
}

export async function writeActivityGeometry(
  db: Db,
  activityId: string,
  geometry: LineString,
): Promise<void> {
  const geojson = JSON.stringify(geometry);
  await db.$executeRaw`
    UPDATE activities
       SET "geom" = ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)
     WHERE id = ${activityId}
  `;
}

/**
 * Replace the recorded altitude on a batch of samples with DEM elevations.
 *
 * Not geometry, but here for the same reason the rest of this file is: it is raw SQL, and
 * raw SQL in this codebase lives in one auditable place. The alternative — one Prisma
 * `updateMany` per sample — is ten thousand round trips for a six-hour hike, which turns
 * the request that ends somebody's recording into a timeout.
 *
 * Matched on `(activityId, t)` rather than on sample id, because the caller works in fixes
 * and `t` is what uniquely identifies one within a recording.
 */
export async function writeSampleElevations(
  db: Db,
  activityId: string,
  samples: ReadonlyArray<{ t: number; eleM: number | null }>,
): Promise<void> {
  if (samples.length === 0) return;
  const ts = samples.map((s) => s.t);
  const eles = samples.map((s) => s.eleM);
  await db.$executeRaw`
    UPDATE activity_samples AS s
       SET "eleM" = v.ele
      FROM (
        SELECT unnest(${ts}::int[]) AS t,
               unnest(${eles}::double precision[]) AS ele
      ) AS v
     WHERE s."activityId" = ${activityId}
       AND s.t = v.t
  `;
}

/**
 * Ids of trails whose line intersects the viewport.
 *
 * Intersection, not containment: a 20 km ridge traverse crossing the screen has neither
 * endpoint on it, and containment would hide exactly the trails a user is most likely
 * to be looking at.
 */
export async function trailIdsInBBox(db: Db, bbox: BBox, limit = 500): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM trails
     WHERE "geom" IS NOT NULL
       AND ST_Intersects(
             "geom",
             ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)
           )
     ORDER BY popularity DESC, id
     LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

export interface NearbyTrail {
  id: string;
  distanceM: number;
}

/**
 * Trails within `radiusM` of a point, nearest first.
 *
 * Distance is measured from the *line*, not the centroid, so a long trail that passes
 * a kilometre away is not reported as 6 km away because its midpoint happens to be.
 *
 * One predicate, deliberately. An earlier version pruned on the centroid first —
 * `ST_DWithin("centroid"::geography, origin, radiusM + "lengthM")` — on the theory that a
 * cheap indexed lookup would narrow the set before the accurate test ran. It did neither: a
 * GiST index built over a geometry column cannot serve a geography operator, and a radius
 * that varies per row defeats index-assisted `ST_DWithin` outright, so the cheap prune was a
 * sequential scan over all 56k trails and the accurate test then re-read whatever survived.
 * Indexing the cast expression instead — `trails_geom_geography_gist`, in spatial.sql — and
 * deleting the prune took this from 3,850 ms to 178 ms on the same rows. Removing a coarse
 * filter can only widen what reaches the accurate one, so the answer is unchanged, or
 * strictly more correct on any trail whose `lengthM` understated its own geometry.
 */
export async function trailIdsNear(
  db: Db,
  at: LngLat,
  radiusM: number,
  limit = 100,
): Promise<NearbyTrail[]> {
  return db.$queryRaw<NearbyTrail[]>`
    WITH origin AS (
      SELECT ST_SetSRID(ST_MakePoint(${at[0]}, ${at[1]}), 4326)::geography AS g
    )
    SELECT id,
           ST_Distance("geom"::geography, origin.g) AS "distanceM"
      FROM trails, origin
     WHERE "geom" IS NOT NULL
       AND ST_DWithin("geom"::geography, origin.g, ${radiusM})
     ORDER BY "distanceM" ASC
     LIMIT ${limit}
  `;
}

export interface TrailGeometryRow {
  id: string;
  geojson: string;
}

/**
 * Full-resolution geometry for specific trails.
 *
 * Ordinary reads use the simplified `geometryJson` column instead — this exists for GPX
 * export and offline bundles, where dropping vertices to a 5 m tolerance would degrade a
 * file the user then navigates by.
 */
export async function readTrailGeometry(db: Db, trailIds: string[]): Promise<TrailGeometryRow[]> {
  if (trailIds.length === 0) return [];
  return db.$queryRaw<TrailGeometryRow[]>`
    SELECT id, ST_AsGeoJSON("geom") AS geojson
      FROM trails
     WHERE id IN (${Prisma.join(trailIds)})
       AND "geom" IS NOT NULL
  `;
}

/**
 * Length of the stored line in metres, measured on the spheroid.
 *
 * Used to check ingest against itself: `packages/geo` computes length with haversine over
 * resampled points, PostGIS computes it with Vincenty over the original vertices, and a
 * disagreement beyond a fraction of a percent means the line was assembled wrong.
 */
export async function measureTrailLengthM(db: Db, trailId: string): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ m: number | null }>>`
    SELECT ST_Length("geom"::geography) AS m FROM trails WHERE id = ${trailId}
  `;
  return rows[0]?.m ?? null;
}
