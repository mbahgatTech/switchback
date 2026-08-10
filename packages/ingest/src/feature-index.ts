/**
 * A uniform grid over one tile's OSM features, so a trail tests the few features near it rather
 * than all of them. Returns a subset of the tile's own array, in the tile's own order.
 */

import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M, TERMINUS_RADIUS_M } from '@switchback/geo';
import { PARKING_BUFFER_M, WAYPOINT_BUFFER_M, classifyWaypoint, featurePosition } from './enrich';
import type { OverpassElement } from './overpass';

const DEG = Math.PI / 180;

/**
 * The widest reach any consumer of the result has. One radius rather than one per kind, because
 * `attachWaypoints` re-tests every candidate against its own buffer anyway: a wider net costs a
 * few more candidates and cannot change the answer, where a narrower one silently loses features.
 */
const QUERY_RADIUS_M = Math.max(WAYPOINT_BUFFER_M, PARKING_BUFFER_M, TERMINUS_RADIUS_M);

/**
 * Cell edge at the equator. Two costs trade off — smaller cells mean more of them swept per
 * trail, larger ones mean more features returned per cell — so the curve has a broad floor
 * rather than a knife edge. Mean ms per trail over the whole of each cached tile:
 *
 *   cell        50    100    150    200    250    500   1000   2000
 *   023010230  0.85  0.570  0.518  0.503  0.526  0.616  0.852  1.375   (30,838 features)
 *   021231030     —  0.163  0.150  0.147  0.144  0.172  0.170      —   (556 features)
 *
 * 250 m sits in the floor on both densities and is half `QUERY_RADIUS_M`, which keeps a short
 * segment's sweep at a 5×5 neighbourhood.
 */
export const FEATURE_CELL_M = 250;

export interface FeatureIndex {
  /**
   * Every feature that could attach to this line — a superset of what `attachWaypoints` and
   * `terminusFeatures` keep, in the order the tile's feature array had them, which is what makes
   * their dedupe and their sort come out the same as an unindexed pass.
   */
  near(coords: readonly LngLat[]): OverpassElement[];
  /** Features held, after dropping those no rule classifies and those with no position. */
  readonly size: number;
  /**
   * Features offered. Kept because ingest reads it to tell a failed feature query from a trail
   * with nothing near it — deriving a null title from no evidence would overwrite a good one.
   */
  readonly sourceCount: number;
}

/** Latitude band → longitude column → indices into the kept-feature array. */
type Bands = Map<number, Map<number, number[]>>;

export function buildFeatureIndex(
  elements: readonly OverpassElement[],
  cellM: number = FEATURE_CELL_M,
): FeatureIndex {
  const cellDeg = cellM / (EARTH_RADIUS_M * DEG);
  const kept: OverpassElement[] = [];
  const bands: Bands = new Map();

  for (const element of elements) {
    // The same three rejections `attachWaypoints` makes, and in its order, so that dropping a
    // feature here can never change which of the survivors a dedupe key sees first.
    if (element.type !== 'node' && element.type !== 'way') continue;
    if (!classifyWaypoint(element.tags ?? {})) continue;
    const at = featurePosition(element);
    if (!at) continue;

    const index = kept.length;
    kept.push(element);
    const latCell = Math.floor(at[1] / cellDeg);
    const lngCell = Math.floor(at[0] / cellDeg);
    let band = bands.get(latCell);
    if (!band) {
      band = new Map<number, number[]>();
      bands.set(latCell, band);
    }
    const column = band.get(lngCell);
    if (column) column.push(index);
    else band.set(lngCell, [index]);
  }

  return {
    size: kept.length,
    sourceCount: elements.length,
    near(coords) {
      if (kept.length === 0 || coords.length === 0) return [];
      const hits = new Set<number>();
      if (coords.length === 1) sweep(bands, cellDeg, coords[0]!, coords[0]!, hits);
      for (let i = 1; i < coords.length; i++)
        sweep(bands, cellDeg, coords[i - 1]!, coords[i]!, hits);
      return [...hits].sort((a, b) => a - b).map((index) => kept[index]!);
    },
  };
}

/**
 * Collect every feature within `QUERY_RADIUS_M` of the segment `a`→`b`.
 *
 * The box swept is the segment's own lng/lat box grown by that radius, which is exactly the
 * region `nearestPointOnSegment` can answer from: it interpolates linearly *in degrees* and
 * measures haversine to that point, so the point it measures from always lies in the segment's
 * box. Grow the box by the buffer and nothing inside the buffer can be outside the box.
 */
function sweep(bands: Bands, cellDeg: number, a: LngLat, b: LngLat, hits: Set<number>): void {
  const latPadDeg = QUERY_RADIUS_M / (EARTH_RADIUS_M * DEG);
  const latLo = Math.min(a[1], b[1]) - latPadDeg;
  const latHi = Math.max(a[1], b[1]) + latPadDeg;

  // Longitude converges at the poles, so the padding is taken at the widest latitude the box
  // reaches, and inverted through asin rather than the small-angle approximation — at 89.9° a
  // 500 m offset is 2.6° of longitude, where sin x ≈ x has already drifted.
  const cos = Math.cos(Math.min(90, Math.max(Math.abs(latLo), Math.abs(latHi))) * DEG);
  const chord = cos > 0 ? QUERY_RADIUS_M / (2 * EARTH_RADIUS_M * cos) : 1;
  const lngPadDeg = chord >= 1 ? 180 : (2 * Math.asin(chord)) / DEG;
  const lngLo = Math.min(a[0], b[0]) - lngPadDeg;
  const lngHi = Math.max(a[0], b[0]) + lngPadDeg;

  const latCellLo = Math.floor(latLo / cellDeg);
  const latCellHi = Math.floor(latHi / cellDeg);
  const lngCellLo = Math.floor(lngLo / cellDeg);
  const lngCellHi = Math.floor(lngHi / cellDeg);

  // A trail crossing the antimeridian is stored as one segment spanning 359.998° of longitude,
  // and near a pole a 500 m box is thousands of cells wide. Both make the occupied cells the
  // shorter list to walk; scanning them is a superset of the range either way.
  if (latCellHi - latCellLo + 1 > bands.size) {
    for (const [latCell, band] of bands) {
      if (latCell >= latCellLo && latCell <= latCellHi) {
        sweepBand(band, lngCellLo, lngCellHi, hits);
      }
    }
    return;
  }
  for (let latCell = latCellLo; latCell <= latCellHi; latCell++) {
    const band = bands.get(latCell);
    if (band) sweepBand(band, lngCellLo, lngCellHi, hits);
  }
}

function sweepBand(
  band: Map<number, number[]>,
  lngCellLo: number,
  lngCellHi: number,
  hits: Set<number>,
): void {
  if (lngCellHi - lngCellLo + 1 > band.size) {
    for (const [lngCell, column] of band) {
      if (lngCell >= lngCellLo && lngCell <= lngCellHi) {
        for (const index of column) hits.add(index);
      }
    }
    return;
  }
  for (let lngCell = lngCellLo; lngCell <= lngCellHi; lngCell++) {
    const column = band.get(lngCell);
    if (column) for (const index of column) hits.add(index);
  }
}
