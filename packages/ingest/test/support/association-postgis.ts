/**
 * Candidate B: the association done as a PostGIS spatial join, against a temporary table of the
 * tile's features. Temporary rather than permanent so a benchmark leaves a database as it found it.
 */

import pg from 'pg';
import type { LngLat } from '@switchback/core';
import { TERMINUS_RADIUS_M, nearestPointOnLine } from '@switchback/geo';
import {
  PARKING_BUFFER_M,
  WAYPOINT_BUFFER_M,
  attachWaypoints,
  classifyWaypoint,
  featurePosition,
  terminusFeatures,
} from '../../src/enrich';
import type { OverpassElement } from '../../src/overpass';
import type { Candidate, TrailInput } from './association';

const QUERY_RADIUS_M = Math.max(WAYPOINT_BUFFER_M, PARKING_BUFFER_M, TERMINUS_RADIUS_M);

/**
 * Slack on the PostGIS radius, because the two sides do not measure the same distance.
 * `ST_DWithin` on a geography works on the WGS84 ellipsoid; `haversineM` works on a sphere of the
 * mean radius. The radius of curvature ranges 6,335–6,400 km against that mean 6,371 km, so the
 * two can disagree by up to 0.56% of the distance — 2.8 m at this 500 m query radius. The second
 * term is curve shape: `nearestPointOnSegment` interpolates in degrees where PostGIS follows the
 * geodesic, which separates by at most `L²·sin φ / 8R` — 0.04 m at the longest segment either
 * fixture holds (1,827 m). Measured worst over every attachment in every trail of both tiles:
 * 1.403 m on 021231030 and 1.178 m on 023010230 (`--pg-margin` reports it, and the suite asserts
 * it stays under this constant). 25 m is eight times the derived bound and a twentieth of the
 * smallest buffer, so it cannot change an answer.
 */
export const POSTGIS_RADIUS_MARGIN_M = 25;

/** Features PostGIS is asked about, and their index in the answer the candidate must return. */
function indexable(elements: readonly OverpassElement[]): {
  kept: OverpassElement[];
  lng: number[];
  lat: number[];
} {
  const kept: OverpassElement[] = [];
  const lng: number[] = [];
  const lat: number[] = [];
  for (const element of elements) {
    if (element.type !== 'node' && element.type !== 'way') continue;
    if (!classifyWaypoint(element.tags ?? {})) continue;
    const at = featurePosition(element);
    if (!at) continue;
    kept.push(element);
    lng.push(at[0]);
    lat.push(at[1]);
  }
  return { kept, lng, lat };
}

/** `attachWaypoints` and `terminusKinds` both answer empty below two vertices. */
function tooShort(coords: readonly LngLat[]): boolean {
  return coords.length < 2;
}

function wkt(coords: readonly LngLat[]): string {
  return `LINESTRING(${coords.map(([x, y]) => `${x} ${y}`).join(',')})`;
}

export interface PostgisSession {
  /** One `ST_DWithin` per trail — the shape that drops into the existing per-trail commit loop. */
  perTrail(): Candidate;
  /** One join for the whole tile, answered before the commit loop starts. */
  bulk(trails: readonly TrailInput[]): Candidate;
  /** Largest disagreement in metres between the two distance functions, over these attachments. */
  measureMargin(
    features: readonly OverpassElement[],
    trails: readonly TrailInput[],
  ): Promise<number>;
  close(): Promise<void>;
}

export async function openPostgis(connectionString: string): Promise<PostgisSession> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  async function loadFeatures(features: readonly OverpassElement[]): Promise<OverpassElement[]> {
    const { kept, lng, lat } = indexable(features);
    await client.query('DROP TABLE IF EXISTS tile_features');
    await client.query(
      'CREATE TEMP TABLE tile_features (idx int PRIMARY KEY, geog geography(Point,4326))',
    );
    await client.query(
      `INSERT INTO tile_features (idx, geog)
       SELECT ord - 1, ST_SetSRID(ST_MakePoint(x, y), 4326)::geography
         FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(x, y, ord)`,
      [lng, lat],
    );
    await client.query('CREATE INDEX tile_features_gist ON tile_features USING GIST (geog)');
    await client.query('ANALYZE tile_features');
    return kept;
  }

  function associator(
    kept: OverpassElement[],
    hits: (coords: readonly LngLat[]) => Promise<number[]>,
  ) {
    return {
      async associate(coords: readonly LngLat[]) {
        const near = tooShort(coords) ? [] : (await hits(coords)).map((idx) => kept[idx]!);
        return {
          waypoints: attachWaypoints(coords, near),
          termini: terminusFeatures(coords, near),
        };
      },
    };
  }

  return {
    perTrail() {
      return {
        name: 'postgis',
        async build(features) {
          const kept = await loadFeatures(features);
          return associator(kept, async (coords) => {
            const rows = await client.query<{ idx: number }>(
              `SELECT idx FROM tile_features
                WHERE ST_DWithin(geog, ST_GeogFromText($1), $2)
                ORDER BY idx`,
              [wkt(coords), QUERY_RADIUS_M + POSTGIS_RADIUS_MARGIN_M],
            );
            return rows.rows.map((row) => row.idx);
          });
        },
      };
    },

    bulk(trails) {
      return {
        name: 'postgis-bulk',
        async build(features) {
          const kept = await loadFeatures(features);
          await client.query('DROP TABLE IF EXISTS tile_trails');
          await client.query('CREATE TEMP TABLE tile_trails (tid int PRIMARY KEY, geog geography)');
          const drawable = trails.filter((trail) => !tooShort(trail.coords));
          await client.query(
            `INSERT INTO tile_trails (tid, geog)
             SELECT ord - 1, ST_GeogFromText(line)
               FROM unnest($1::text[]) WITH ORDINALITY AS t(line, ord)`,
            [drawable.map((trail) => wkt(trail.coords))],
          );
          await client.query('CREATE INDEX tile_trails_gist ON tile_trails USING GIST (geog)');
          await client.query('ANALYZE tile_trails');

          const joined = await client.query<{ tid: number; idx: number }>(
            `SELECT t.tid, f.idx
               FROM tile_trails t JOIN tile_features f ON ST_DWithin(f.geog, t.geog, $1)
              ORDER BY t.tid, f.idx`,
            [QUERY_RADIUS_M + POSTGIS_RADIUS_MARGIN_M],
          );
          const byTrail = new Map<readonly LngLat[], number[]>();
          for (const { tid, idx } of joined.rows) {
            const coords = drawable[tid]!.coords;
            const list = byTrail.get(coords);
            if (list) list.push(idx);
            else byTrail.set(coords, [idx]);
          }
          return associator(kept, (coords) => Promise.resolve(byTrail.get(coords) ?? []));
        },
      };
    },

    async measureMargin(features, trails) {
      const kept = await loadFeatures(features);
      let worst = 0;
      let compared = 0;
      for (const trail of trails) {
        if (tooShort(trail.coords)) continue;
        const attached = attachWaypoints(trail.coords, kept);
        if (attached.length === 0) continue;
        // One round trip per trail, not per waypoint: the line is the expensive parameter and a
        // 7,000-vertex WKT sent once per attachment turns this into an hour.
        const { rows } = await client.query<{ d: string }>(
          `SELECT ST_Distance(ST_GeogFromText($1), ST_MakePoint(x, y)::geography) AS d
             FROM unnest($2::float8[], $3::float8[]) AS t(x, y)`,
          [
            wkt(trail.coords),
            attached.map((waypoint) => waypoint.lng),
            attached.map((waypoint) => waypoint.lat),
          ],
        );
        for (const [index, waypoint] of attached.entries()) {
          const at: LngLat = [waypoint.lng, waypoint.lat];
          // `offsetM` on the row is rounded to the metre, so the JS side is recomputed here.
          const gap = Math.abs(Number(rows[index]!.d) - nearestPointOnLine(at, trail.coords).distM);
          compared += 1;
          if (gap > worst) worst = gap;
        }
      }
      if (compared === 0) throw new Error('measureMargin: nothing attached, nothing measured');
      return worst;
    },

    async close() {
      await client.end();
    },
  };
}
