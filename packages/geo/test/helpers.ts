import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M } from '@switchback/geo';

/**
 * Synthetic-geometry helpers for the geo tests.
 *
 * Fixtures are built from metre offsets rather than hand-typed coordinates so that the
 * expected values in each test are derived from the intent ("a 1 km path climbing 100 m")
 * instead of from whatever the implementation happened to produce.
 */

/** Metres per degree of latitude on the sphere the distance code assumes. */
export const M_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180;

export function mPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Move a point by metres north (+) and east (+). */
export function offset(origin: LngLat, northM: number, eastM: number): LngLat {
  const lat = origin[1] + northM / M_PER_DEG_LAT;
  return [origin[0] + eastM / mPerDegLng(origin[1]), lat];
}

/** A straight north-running line of `count` vertices spanning `lengthM`. */
export function lineNorth(origin: LngLat, lengthM: number, count: number): LngLat[] {
  return Array.from({ length: count }, (_, i) => offset(origin, (lengthM * i) / (count - 1), 0));
}

/** A square circuit returning to its start, `sideM` on a side, 4 vertices per side. */
export function square(origin: LngLat, sideM: number): LngLat[] {
  const out: LngLat[] = [];
  const per = 8;
  const corners: Array<[number, number]> = [
    [0, 0],
    [sideM, 0],
    [sideM, sideM],
    [0, sideM],
    [0, 0],
  ];
  for (let c = 1; c < corners.length; c++) {
    const [n0, e0] = corners[c - 1]!;
    const [n1, e1] = corners[c]!;
    for (let i = 0; i < per; i++) {
      const t = i / per;
      out.push(offset(origin, n0 + (n1 - n0) * t, e0 + (e1 - e0) * t));
    }
  }
  out.push(origin);
  return out;
}

/**
 * An out-and-back: north to a turnaround, then back along a line offset by
 * `offsetM` — a few metres, as a real GPS-traced return leg would be.
 */
export function outAndBack(origin: LngLat, legLengthM: number, offsetM = 3): LngLat[] {
  const out = lineNorth(origin, legLengthM, 21);
  const back = out
    .slice(0, -1)
    .reverse()
    .map((p) => offset(p, 0, offsetM));
  return [...out, ...back];
}
