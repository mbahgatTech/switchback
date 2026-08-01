import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M, cumulativeDistancesM, haversineM } from './distance';

/**
 * Resample a line to evenly spaced points, preserving the first and last vertices exactly. Raw
 * OSM spacing is wildly uneven, and everything downstream — elevation sampling, grade, ETA,
 * charts — assumes uniform spacing, so this normalisation happens once at ingest.
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
 * Ramer–Douglas–Peucker simplification with a metre tolerance, for map rendering at low zoom and
 * offline bundles. Never applied to geometry used for distance or gain — that would understate both.
 */
export function simplifyLine(coords: readonly LngLat[], toleranceM: number): LngLat[] {
  return simplifyIndices(coords, toleranceM).map((i) => coords[i]!);
}

/**
 * The indices `simplifyLine` would keep. Split out because a recorded fix carries a timestamp,
 * accuracy and heart rate too, and matching survivors back by coordinate value is both slow and
 * wrong — a track crossing its own path has duplicate coordinates.
 */
export function simplifyIndices(coords: readonly LngLat[], toleranceM: number): number[] {
  if (coords.length <= 2 || toleranceM <= 0) return coords.map((_, i) => i);

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  // Project once into a local equirectangular frame in metres and search in plane geometry: the
  // inner loop is O(n²) on a jittery recorded track, and a haversine per iteration turns that
  // into tens of seconds. Over one trail's extent the projection error is far below a metre.
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
      // Clamped to the segment, matching nearestPointOnSegment: an outlier beyond either end is
      // measured to the endpoint, not to the infinite line it happens to lie near.
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

/** Whether a line returns to its own start within `thresholdM` — the basis of loop detection. */
export function isClosedLoop(coords: readonly LngLat[], thresholdM = 200): boolean {
  if (coords.length < 3) return false;
  return haversineM(coords[0]!, coords[coords.length - 1]!) <= thresholdM;
}
