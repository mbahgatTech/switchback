import type { BBox, LngLat, LineString } from '@switchback/core';
import { Prisma } from '@prisma/client';
import type { prisma } from './client';

/**
 * Raw-SQL access to the PostGIS columns Prisma cannot see (`Unsupported`). Every geometry read
 * and write lives here, so this file is the only place in the codebase interpolating into SQL —
 * all of it through tagged templates, which parameterise rather than concatenate.
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
 * Write a trail's geometry, centroid, and search vector — together, in the same transaction as
 * `trail.create()`. A row with geometry but no search vector maps but never appears in search.
 * Search weights: name (A) beats region (B) beats description (C).
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
 * Give every one of a trail's waypoints its PostGIS point, in one statement. The coordinates are
 * already on the rows, so this is a projection of a row onto itself — no ids, no matching array,
 * no assumption about row order. One statement rather than two round-trips per waypoint, which
 * is what kept a forty-waypoint trail inside the transaction's 30 s ceiling.
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
 * Replace the recorded altitude on a batch of samples with DEM elevations. Here because it is
 * raw SQL, and raw SQL lives in one auditable place; one `updateMany` per sample would be ten
 * thousand round trips for a six-hour hike. Matched on `(activityId, t)`, since `t` is what
 * identifies a fix within a recording.
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
 * Ids of trails whose line intersects the viewport. Intersection, not containment: a ridge
 * traverse crossing the screen has neither endpoint on it.
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
 * Trails within `radiusM` of a point, nearest first. Distance is measured from the *line*, not
 * the centroid, so a long trail passing a kilometre away is not reported as 6 km.
 *
 * Deliberately one predicate, with no centroid pre-filter: a per-row radius defeats
 * index-assisted `ST_DWithin`, and a GiST index over a geometry column cannot serve a geography
 * operator. The index that does serve this is on the cast expression —
 * `trails_geom_geography_gist` in spatial.sql — so do not add a "cheap" prune back.
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
 * Full-resolution geometry for specific trails. Ordinary reads use the simplified
 * `geometryJson` column; this is for GPX export and offline bundles, which are navigated by.
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
 * Length of the stored line in metres, on the spheroid. Checks ingest against itself: geo
 * computes haversine over resampled points, PostGIS Vincenty over the original vertices, and a
 * disagreement beyond a fraction of a percent means the line was assembled wrong.
 */
export async function measureTrailLengthM(db: Db, trailId: string): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ m: number | null }>>`
    SELECT ST_Length("geom"::geography) AS m FROM trails WHERE id = ${trailId}
  `;
  return rows[0]?.m ?? null;
}
