import type { BBox, LngLat } from '@switchback/core';

/** IUGG mean Earth radius. */
export const EARTH_RADIUS_M = 6_371_008.8;

const DEG = Math.PI / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the spheroidal Vincenty: at trail scales the ellipsoidal
 * correction is well under 0.5%, far below the error already present in OSM geometry
 * and DEM sampling, and haversine is numerically stable for the short segments that
 * dominate a resampled trail.
 */
export function haversineM(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from `a` to `b`, degrees clockwise from true north. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLng = (lng2 - lng1) * DEG;
  const y = Math.sin(dLng) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * The eight points of the compass, in bearing order from north.
 *
 * Eight rather than sixteen on purpose. A bearing is only ever shown here alongside a
 * distance from somewhere approximate — the reader's town, an IP lookup, a GPS fix taken
 * indoors — and "NNW" claims a precision the origin does not have. Eight points is the
 * resolution a person can actually act on: up the valley, back toward the coast.
 */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export type CompassPoint = (typeof COMPASS)[number];

/**
 * A bearing as a compass point, the way a signpost writes it.
 *
 * Each point owns 45° centred on its own direction, so north is 337.5°–22.5° and not
 * 0°–45° — the off-by-half-a-sector version of this is the classic bug, and it puts a
 * trail due east of you in the northeast column.
 */
export function compassPoint(deg: number): CompassPoint {
  if (!Number.isFinite(deg)) return 'N';
  const index = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return COMPASS[index]!;
}

/** Total length of a coordinate list, in metres. */
export function lineLengthM(coords: readonly LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(coords[i - 1]!, coords[i]!);
  }
  return total;
}

/**
 * Cumulative distance at each vertex. `result[0]` is always 0 and `result.length`
 * equals `coords.length`, which lets callers index profile and geometry in lockstep.
 */
export function cumulativeDistancesM(coords: readonly LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i] = out[i - 1]! + haversineM(coords[i - 1]!, coords[i]!);
  }
  return out;
}

export function bboxOf(coords: readonly LngLat[]): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** Expand a bbox by a distance in metres, for buffered spatial queries. */
export function padBBox(bbox: BBox, metres: number): BBox {
  const [w, s, e, n] = bbox;
  const latPad = metres / EARTH_RADIUS_M / DEG;
  const midLat = (s + n) / 2;
  const cos = Math.max(Math.cos(midLat * DEG), 1e-6);
  const lngPad = latPad / cos;
  return [
    Math.max(-180, w - lngPad),
    Math.max(-90, s - latPad),
    Math.min(180, e + lngPad),
    Math.min(90, n + latPad),
  ];
}

/**
 * Local tangent-plane projection: longitude/latitude degrees to metres, relative to
 * an origin. Segment-level geometry (nearest point, cross-track distance) is done in
 * this flat space because the error over a few hundred metres is negligible and the
 * maths is exact rather than approximate.
 */
function toLocalM(p: LngLat, origin: LngLat): [number, number] {
  const cos = Math.cos(origin[1] * DEG);
  return [
    (p[0] - origin[0]) * DEG * EARTH_RADIUS_M * cos,
    (p[1] - origin[1]) * DEG * EARTH_RADIUS_M,
  ];
}

export interface NearestOnSegment {
  distM: number;
  /** Interpolation parameter along the segment, clamped to [0, 1]. */
  t: number;
  closest: LngLat;
}

/** Perpendicular distance from `p` to segment `a`→`b`, and the closest point on it. */
export function nearestPointOnSegment(p: LngLat, a: LngLat, b: LngLat): NearestOnSegment {
  const [ax, ay] = toLocalM(a, a);
  const [bx, by] = toLocalM(b, a);
  const [px, py] = toLocalM(p, a);

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  // Degenerate segment (duplicate vertices are common in raw OSM data).
  if (lenSq === 0) return { distM: haversineM(p, a), t: 0, closest: a };

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const closest: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { distM: haversineM(p, closest), t, closest };
}

export interface NearestOnLine extends NearestOnSegment {
  /** Index of the segment's first vertex. */
  segmentIndex: number;
  /** Distance from the line's start to the closest point, in metres. */
  alongM: number;
}

/**
 * Nearest point on a polyline. This is the primitive behind wrong-turn alerts
 * (`distM` is cross-track error) and behind "you are 4.2 km in" (`alongM`).
 *
 * Linear in vertex count. Callers tracking a live GPS feed should pass a windowed
 * slice around the last known position rather than the whole trail on every fix.
 */
export function nearestPointOnLine(p: LngLat, coords: readonly LngLat[]): NearestOnLine {
  if (coords.length === 0) throw new Error('nearestPointOnLine: empty line');
  if (coords.length === 1) {
    return {
      distM: haversineM(p, coords[0]!),
      t: 0,
      closest: coords[0]!,
      segmentIndex: 0,
      alongM: 0,
    };
  }

  let best: NearestOnLine | null = null;
  let travelled = 0;

  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const segLen = haversineM(a, b);
    const hit = nearestPointOnSegment(p, a, b);
    if (best === null || hit.distM < best.distM) {
      best = { ...hit, segmentIndex: i - 1, alongM: travelled + segLen * hit.t };
    }
    travelled += segLen;
  }

  return best!;
}
