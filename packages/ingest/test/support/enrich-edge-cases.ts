/**
 * Synthetic cases the two real tiles cannot be trusted to contain. Each names the features the
 * baseline must and must not attach, so a case that stopped exercising anything fails.
 */

import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M } from '@switchback/geo';
import { PARKING_BUFFER_M, WAYPOINT_BUFFER_M, attachWaypoints } from '../../src/enrich';
import { FEATURE_CELL_M } from '../../src/feature-index';
import type { OverpassElement, OverpassNode } from '../../src/overpass';
import type { TrailInput } from './association';

const DEG = Math.PI / 180;

/**
 * Cell sizes the boundary cases are built against — the two buffer radii, and the grid's own
 * cell. A candidate that picks a different cell size must add its own cases; these stop being
 * boundaries for it.
 */
export const BOUNDARY_CELL_M = [WAYPOINT_BUFFER_M, FEATURE_CELL_M, PARKING_BUFFER_M] as const;

export interface EdgeCase {
  name: string;
  why: string;
  trails: TrailInput[];
  features: OverpassElement[];
  /** Feature keys (`node/1`) the baseline attaches to at least one trail in this case. */
  mustAttach: string[];
  /** Feature keys the baseline attaches to no trail — the half a broken index passes anyway. */
  mustNotAttach: string[];
}

let nextId = 1;

function node(at: LngLat, tags: Record<string, string>): OverpassNode {
  return { type: 'node', id: nextId++, lat: at[1], lon: at[0], tags };
}

function key(element: OverpassNode): string {
  return `node/${element.id}`;
}

function north(from: LngLat, metres: number): LngLat {
  return [from[0], from[1] + metres / (EARTH_RADIUS_M * DEG)];
}

function east(from: LngLat, metres: number): LngLat {
  return [from[0] + metres / (EARTH_RADIUS_M * DEG * Math.cos(from[1] * DEG)), from[1]];
}

/** Degrees of latitude one grid cell spans, for a grid anchored on the equator. */
function latCellDeg(metres: number): number {
  return metres / (EARTH_RADIUS_M * DEG);
}

/**
 * The offset where the baseline flips from attaching to dropping, measured rather than assumed:
 * the buffer is compared against a haversine distance to a point found in a tangent plane.
 */
function attachThresholdM(line: readonly LngLat[], from: LngLat, bufferM: number): number {
  let low = bufferM * 0.5;
  let high = bufferM * 1.5;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const probe = node(north(from, mid), { natural: 'peak' });
    if (attachWaypoints(line, [probe]).length > 0) low = mid;
    else high = mid;
  }
  return low;
}

function bufferEpsilon(): EdgeCase {
  const start: LngLat = [-120, 45];
  const line: LngLat[] = [start, east(start, 2_000)];
  const midpoint = east(start, 1_000);
  const threshold = attachThresholdM(line, midpoint, WAYPOINT_BUFFER_M);

  const inside = node(north(midpoint, threshold - 1e-6), { natural: 'peak', name: 'Inside' });
  const outside = node(north(midpoint, threshold + 1e-6), { natural: 'peak', name: 'Outside' });

  return {
    name: 'buffer-epsilon',
    why: `two features 2 µm apart across the measured ${threshold.toFixed(6)} m attach threshold`,
    trails: [{ key: 'epsilon', coords: line }],
    features: [inside, outside],
    mustAttach: [key(inside)],
    mustNotAttach: [key(outside)],
  };
}

function cellBoundary(cellM: number): EdgeCase {
  const cell = latCellDeg(cellM);
  // A latitude that is an exact multiple of the cell size, so a grid anchored on the equator
  // puts its boundary through the trail itself.
  const boundaryLat = Math.round(45 / cell) * cell;
  const start: LngLat = [-120, boundaryLat];
  // Vertices every 50 m, so the trail occupies a contiguous run of cells along its length and the
  // only thing a cell-blind index can miss here is the boundary the trail lies on.
  const line: LngLat[] = [];
  for (let m = 0; m <= 4_000; m += 50) line.push(east(start, m));
  const midpoint = east(start, 2_000);

  const onBoundary = node(midpoint, { natural: 'peak', name: `On ${cellM} m boundary` });
  const justOver = node(north(midpoint, 1e-3), { tourism: 'viewpoint', name: 'Just over' });
  const justUnder = node(north(midpoint, -1e-3), { waterway: 'waterfall', name: 'Just under' });
  // A whole cell away, so a grid that searches only the trail's own cells drops both. Whether
  // the baseline keeps them is arithmetic on the declared buffers, not a fact about the index.
  const neighbourOffsetM = cellM * 1.02;
  const parking = node(north(midpoint, neighbourOffsetM), {
    amenity: 'parking',
    name: 'Neighbour cell parking',
  });
  const summit = node(north(midpoint, neighbourOffsetM), {
    natural: 'peak',
    name: 'Neighbour cell summit',
  });

  const attached = [key(onBoundary), key(justOver), key(justUnder)];
  const dropped: string[] = [];
  (neighbourOffsetM < PARKING_BUFFER_M ? attached : dropped).push(key(parking));
  (neighbourOffsetM < WAYPOINT_BUFFER_M ? attached : dropped).push(key(summit));

  return {
    name: `cell-boundary-${cellM}m`,
    why: `features on, either side of, and one cell beyond a ${cellM} m grid line through the trail`,
    trails: [{ key: `boundary-${cellM}`, coords: line }],
    features: [onBoundary, justOver, justUnder, parking, summit],
    mustAttach: attached,
    mustNotAttach: dropped,
  };
}

function manyCells(): EdgeCase {
  // 60 km east-west: hundreds of cells at either boundary candidate, against a trail that fits
  // in one. Both get the same features, so a grid that only ever looks in the origin cell
  // diverges on the long one and not the short one.
  const start: LngLat = [-121.5, 44];
  const long: LngLat[] = [];
  for (let m = 0; m <= 60_000; m += 500) long.push(east(start, m));
  const short: LngLat[] = [east(start, 30_000), east(start, 30_100)];

  const nearFarEnd = node(north(east(start, 59_000), 40), { natural: 'peak', name: 'Far end' });
  const nearShort = node(north(east(start, 30_050), 40), { tourism: 'viewpoint', name: 'Near' });
  const nowhereNear = node(north(east(start, 30_050), 5_000), {
    natural: 'peak',
    name: 'Nowhere near',
  });

  return {
    name: 'trail-across-many-cells',
    why: 'a 60 km line beside a 100 m one, sharing a feature set',
    trails: [
      { key: 'long', coords: long },
      { key: 'short', coords: short },
    ],
    features: [nearFarEnd, nearShort, nowhereNear],
    mustAttach: [key(nearFarEnd), key(nearShort)],
    mustNotAttach: [key(nowhereNear)],
  };
}

function beyondExtent(): EdgeCase {
  // Every feature sits north of the trail, so the trail's own bounds and the feature extent do
  // not coincide — an index sized to the trails, or to a tile box, loses these.
  const start: LngLat = [-122, 47];
  const line: LngLat[] = [start, east(start, 1_000)];
  const above = node(north(east(start, 500), 120), { natural: 'peak', name: 'Above' });
  const wellAbove = node(north(east(start, 500), 400), { amenity: 'parking', name: 'Car park' });

  return {
    name: 'features-outside-trail-bounds',
    why: 'a trail at an extent edge whose features all lie beyond it',
    trails: [{ key: 'edge', coords: line }],
    features: [above, wellAbove],
    mustAttach: [key(above), key(wellAbove)],
    mustNotAttach: [],
  };
}

function antimeridian(): EdgeCase {
  const line: LngLat[] = [
    [179.999, -16.5],
    [-179.999, -16.5],
  ];
  const onSeam = node([180, -16.5], { natural: 'peak', name: 'Seam' });
  const westOfSeam = node([179.9995, -16.5], { tourism: 'viewpoint', name: 'West of seam' });
  const eastOfSeam = node([-179.9995, -16.5], { waterway: 'waterfall', name: 'East of seam' });

  return {
    name: 'antimeridian',
    why: 'a line whose two vertices differ by 359.998 degrees of longitude',
    trails: [{ key: 'seam', coords: line }],
    features: [onSeam, westOfSeam, eastOfSeam],
    // Asserted from the baseline's own behaviour, not from what a correct answer would be:
    // `nearestPointOnSegment` projects into a tangent plane that does not wrap, so the baseline
    // reads this line as a 40,000 km one running west. The bar for a candidate is to agree.
    mustAttach: [key(onSeam), key(westOfSeam), key(eastOfSeam)],
    mustNotAttach: [],
  };
}

function polar(): EdgeCase {
  const start: LngLat = [15, 89.9];
  const line: LngLat[] = [start, east(start, 2_000)];
  const near = node(north(east(start, 1_000), 60), { natural: 'peak', name: 'Polar peak' });
  const far = node(north(east(start, 1_000), 900), { natural: 'peak', name: 'Polar far' });

  return {
    name: 'polar',
    why: 'latitude 89.9, where a degree of longitude is 194 m',
    trails: [{ key: 'polar', coords: line }],
    features: [near, far],
    mustAttach: [key(near)],
    mustNotAttach: [key(far)],
  };
}

function emptyAndSingle(): EdgeCase[] {
  const start: LngLat = [-118, 36];
  const line: LngLat[] = [start, east(start, 1_000)];
  const only = node(north(east(start, 500), 50), { natural: 'peak', name: 'Only' });
  return [
    {
      name: 'empty-feature-set',
      why: 'nothing to index',
      trails: [{ key: 'empty', coords: line }],
      features: [],
      mustAttach: [],
      mustNotAttach: [],
    },
    {
      name: 'single-feature-set',
      why: 'one feature, one cell',
      trails: [{ key: 'single', coords: line }],
      features: [only],
      mustAttach: [key(only)],
      mustNotAttach: [],
    },
  ];
}

function duplicates(): EdgeCase {
  const start: LngLat = [-105, 39.7];
  const line: LngLat[] = [start, east(start, 1_000)];
  const at = north(east(start, 500), 50);
  const first = node(at, { natural: 'peak', name: 'Twin' });
  const second = node(at, { natural: 'peak', name: 'Twin' });
  const third = node(at, { natural: 'peak', name: 'Twin' });

  return {
    name: 'duplicate-features',
    why: 'three identical peaks the dedupe key collapses to whichever is visited first',
    trails: [{ key: 'dupes', coords: line }],
    features: [first, second, third],
    mustAttach: [key(first)],
    mustNotAttach: [key(second), key(third)],
  };
}

function degenerateTrails(): EdgeCase {
  const at: LngLat = [-100, 40];
  const beside = node(north(at, 50), { natural: 'peak', name: 'Beside' });
  return {
    name: 'degenerate-trails',
    why: 'a one-vertex line, and a line whose every segment has zero length',
    trails: [
      { key: 'one-vertex', coords: [at] },
      { key: 'zero-length', coords: [at, at, at] },
      { key: 'no-vertices', coords: [] },
    ],
    features: [beside],
    // `attachWaypoints` returns [] below two vertices, so only the three-coincident-vertex line
    // reaches the degenerate-segment branch of `nearestPointOnSegment` and attaches anything.
    mustAttach: [key(beside)],
    mustNotAttach: [],
  };
}

export function edgeCases(): EdgeCase[] {
  nextId = 1;
  return [
    bufferEpsilon(),
    ...BOUNDARY_CELL_M.map(cellBoundary),
    manyCells(),
    beyondExtent(),
    antimeridian(),
    polar(),
    ...emptyAndSingle(),
    duplicates(),
    degenerateTrails(),
  ];
}
