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
}

/**
 * Write a trail's geometry, centroid, and search vector — together, in the same transaction as
 * `trail.create()`. A row with geometry but no search vector maps but never appears in search.
 */
export async function writeTrailGeometry(db: Db, input: TrailGeometryInput): Promise<void> {
  await writeTrailGeometries(db, [input]);
}

/**
 * Rebuild a trail's search vector from the row's own columns — a projection of a row onto
 * itself, like `writeWaypointPoints`, so the vector cannot disagree with what the columns say.
 * The caller must have written the row first; inside ingest's transaction it has.
 *
 * Weights: the two names (A) beat region (B) beats description (C). `displayName` sits at the
 * same weight as `name` rather than below it because it is the title the reader is shown —
 * somebody typing "Vesper Peak" is naming the trail, not describing it. Concatenating the two
 * rather than choosing between them keeps the OSM name findable: a reader matching a signpost
 * still reaches the trail whichever of the two is on it.
 */
export async function refreshTrailSearchVector(db: Db, trailId: string): Promise<void> {
  await refreshTrailSearchVectors(db, [trailId]);
}

/**
 * The same projection over many rows in one statement. `writeTrailGeometries` is the only
 * caller that needs it; `refreshTrailSearchVector` delegates so the expression exists once.
 */
export async function refreshTrailSearchVectors(
  db: Db,
  trailIds: readonly string[],
): Promise<void> {
  if (trailIds.length === 0) return;
  await db.$executeRaw`
    UPDATE trails SET
      "searchVector" =
          setweight(to_tsvector('english', "name"), 'A')
       || setweight(to_tsvector('english', COALESCE("displayName", '')), 'A')
       || setweight(to_tsvector('english', COALESCE("regionName", '')), 'B')
       || setweight(to_tsvector('english', COALESCE("description", '')), 'C')
    WHERE id = ANY(${[...trailIds]}::text[])
  `;
}

/**
 * Geometry, centroid and search vector for a whole batch of trails in two statements. The
 * per-row `writeTrailGeometry` is `writeTrailGeometries` of one, so the SQL exists once.
 */
export async function writeTrailGeometries(
  db: Db,
  inputs: readonly TrailGeometryInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  const ids = inputs.map((input) => input.trailId);
  const geojson = inputs.map((input) => JSON.stringify(input.geometry));
  const lngs = inputs.map((input) => input.centroid[0]);
  const lats = inputs.map((input) => input.centroid[1]);

  await db.$executeRaw`
    UPDATE trails AS t SET
      "geom"     = ST_SetSRID(ST_GeomFromGeoJSON(v.geojson), 4326),
      "centroid" = ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)
      FROM (
        SELECT unnest(${ids}::text[])     AS id,
               unnest(${geojson}::text[]) AS geojson,
               unnest(${lngs}::double precision[]) AS lng,
               unnest(${lats}::double precision[]) AS lat
      ) AS v
     WHERE t.id = v.id
  `;
  await refreshTrailSearchVectors(db, ids);
}

/**
 * Give every one of a trail's waypoints its PostGIS point, in one statement. The coordinates are
 * already on the rows, so this is a projection of a row onto itself — no ids, no matching array,
 * no assumption about row order. One statement rather than two round-trips per waypoint, which
 * is what kept a forty-waypoint trail inside the transaction's 30 s ceiling.
 */
export async function writeWaypointPoints(db: Db, trailId: string): Promise<void> {
  await writeWaypointPointsFor(db, [trailId]);
}

/** The same projection for a batch of trails, still one statement. */
export async function writeWaypointPointsFor(db: Db, trailIds: readonly string[]): Promise<void> {
  if (trailIds.length === 0) return;
  await db.$executeRaw`
    UPDATE waypoints
       SET "point" = ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)
     WHERE "trailId" = ANY(${[...trailIds]}::text[])
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

export interface MergedGeometry {
  coords: LngLat[];
  /**
   * False when the union was refused and `coords` is the stored line untouched. The caller must
   * not retire anything on a refusal: the incoming line is not represented in what it gets back.
   */
  unioned: boolean;
}

/**
 * Union a stored trail line with an incoming one — and with the lines of any trails the caller
 * is about to retire into it — returning the result as coordinates.
 *
 * Geometric, not concatenation: two tiles assembling the same seam-crossing trail return
 * overlapping lines — a mean 2.79 km of shared line across the 238 fragmented pairs measured in
 * production — so splicing the arrays would add that overlap to the length twice. `ST_UnaryUnion`
 * dissolves it and `ST_LineMerge` stitches what remains back into one line.
 *
 * A result that is still a MultiLineString is the refusal case — 53 of those 269 pairs. It means
 * the inputs fork or do not touch, so no single line represents them all, and `Trail.geom` is
 * `geometry(LineString, 4326)` with nowhere to put the rest. Taking the longest component would
 * delete stored geometry irreversibly, so the stored line is handed back unchanged and `unioned`
 * is false — which is also the caller's signal that retiring anything would lose it.
 */
export async function mergeTrailGeometry(
  db: Db,
  input: { trailId: string; incoming: LineString; alsoTrailIds?: readonly string[] },
): Promise<MergedGeometry | null> {
  const geojson = JSON.stringify(input.incoming);
  const ids = [input.trailId, ...(input.alsoTrailIds ?? [])];
  const rows = await db.$queryRaw<Array<{ geojson: string | null; unioned: boolean | null }>>`
    WITH incoming AS (
      SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) AS g
    ),
    existing AS (
      SELECT t."geom" AS g FROM trails t WHERE t.id = ${input.trailId}
    ),
    parts AS (
      SELECT ST_Collect(t."geom") AS g
        FROM trails t
       WHERE t.id IN (${Prisma.join(ids)}) AND t."geom" IS NOT NULL
    ),
    unioned AS (
      SELECT ST_LineMerge(ST_UnaryUnion(ST_Collect(COALESCE(p.g, i.g), i.g))) AS g
        FROM parts p, incoming i
    ),
    chosen AS (
      SELECT GeometryType(u.g) = 'LINESTRING'
             AND ST_Length(u.g::geography) + 0.5 >= COALESCE(ST_Length(e.g::geography), 0)
               AS unioned,
             u.g AS union_g,
             e.g AS existing_g
        FROM unioned u, existing e
    )
    SELECT unioned,
           ST_AsGeoJSON(CASE WHEN unioned THEN union_g ELSE existing_g END) AS geojson
      FROM chosen
  `;

  const row = rows[0];
  if (!row?.geojson) return null;
  const parsed = JSON.parse(row.geojson) as { type: string; coordinates: LngLat[] };
  if (parsed.type !== 'LineString' || parsed.coordinates.length < 2) return null;

  return { coords: parsed.coordinates, unioned: row.unioned === true };
}
