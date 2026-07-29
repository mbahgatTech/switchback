import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M, cumulativeDistancesM, haversineM } from './distance';

/**
 * Resample a line to evenly spaced points.
 *
 * Raw OSM geometry has wildly uneven vertex spacing — a straight forest road may be
 * two points a kilometre apart, while a switchback stack has a vertex every two
 * metres. Every downstream calculation (elevation sampling, grade, ETA, chart
 * rendering) assumes uniform spacing, so this normalisation happens once at ingest
 * and everything after it can be simple.
 *
 * The first and last vertices are always preserved exactly.
 */
export function resampleLine(coords: readonly LngLat[], spacingM: number): LngLat[] {
  if (spacingM <= 0) throw new Error('resampleLine: spacingM must be positive');
  if (coords.length < 2) return [...coords];

  const cum = cumulativeDistancesM(coords);
  const total = cum[cum.length - 1]!;
  if (total === 0) return [coords[0]!];

  const steps = Math.max(1, Math.round(total / spacingM));
  const out: LngLat[] = [coords[0]!];

  let seg = 1;
  for (let i = 1; i < steps; i++) {
    const target = (total * i) / steps;
    while (seg < cum.length - 1 && cum[seg]! < target) seg++;
    const d0 = cum[seg - 1]!;
    const d1 = cum[seg]!;
    const span = d1 - d0;
    const t = span === 0 ? 0 : (target - d0) / span;
    const a = coords[seg - 1]!;
    const b = coords[seg]!;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }

  out.push(coords[coords.length - 1]!);
  return out;
}

/**
 * Ramer–Douglas–Peucker simplification with a metre-denominated tolerance.
 *
 * Used to shrink geometry for map rendering at low zoom and for offline bundles,
 * where a 12,000-point trail is wasteful. Never applied to the geometry used for
 * distance or gain calculations — simplifying before measuring would understate both.
 */
export function simplifyLine(coords: readonly LngLat[], toleranceM: number): LngLat[] {
  return simplifyIndices(coords, toleranceM).map((i) => coords[i]!);
}

/**
 * The indices `simplifyLine` would keep.
 *
 * Split out because a recorded track is not only coordinates: every fix also carries a
 * timestamp, an accuracy, a heart rate. Simplifying the coordinates and then trying to
 * match the survivors back to their fixes by value is both slow and wrong — a track that
 * crosses its own path has duplicate coordinates and no way to tell which one survived.
 * Indices carry that identity for free.
 */
export function simplifyIndices(coords: readonly LngLat[], toleranceM: number): number[] {
  if (coords.length <= 2 || toleranceM <= 0) return coords.map((_, i) => i);

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  // Project once into a local equirectangular frame in metres, then do the whole search
  // in plane geometry. The inner loop runs O(n²) times on the input that matters most —
  // a jittery recorded track, where consecutive fixes alternate either side of the line
  // so no subrange can be pruned — and a haversine per iteration turns that into tens of
  // seconds for a few hours of 1 Hz recording. Over the extent of one trail the
  // projection error is orders of magnitude below a metre-scale tolerance.
  const mPerDegLat = (EARTH_RADIUS_M * Math.PI) / 180;
  const mPerDegLng = mPerDegLat * Math.cos((coords[coords.length >> 1]![1] * Math.PI) / 180);
  const xs = new Float64Array(coords.length);
  const ys = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i++) {
    xs[i] = coords[i]![0] * mPerDegLng;
    ys[i] = coords[i]![1] * mPerDegLat;
  }

  // Compared squared, so the loop needs no square root either.
  const toleranceSq = toleranceM * toleranceM;

  // Iterative rather than recursive: a long trail can otherwise blow the stack.
  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const ax = xs[first]!;
    const ay = ys[first]!;
    const dx = xs[last]! - ax;
    const dy = ys[last]! - ay;
    const spanSq = dx * dx + dy * dy;

    let maxSq = -1;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const px = xs[i]! - ax;
      const py = ys[i]! - ay;
      // Clamped to the segment, matching nearestPointOnSegment: an outlier beyond either
      // end is measured to the endpoint, not to the infinite line it happens to lie near.
      const t = spanSq === 0 ? 0 : Math.min(1, Math.max(0, (px * dx + py * dy) / spanSq));
      const ex = px - dx * t;
      const ey = py - dy * t;
      const distSq = ex * ex + ey * ey;
      if (distSq > maxSq) {
        maxSq = distSq;
        index = i;
      }
    }

    if (maxSq > toleranceSq && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Whether a line returns to its own start, within `thresholdM`.
 * The basis of loop detection.
 */
export function isClosedLoop(coords: readonly LngLat[], thresholdM = 200): boolean {
  if (coords.length < 3) return false;
  return haversineM(coords[0]!, coords[coords.length - 1]!) <= thresholdM;
}
