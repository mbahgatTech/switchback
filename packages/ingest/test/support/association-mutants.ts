/**
 * Broken associators, each wrong in one way a real spatial index could be. They prove the
 * comparison can fail: a harness that passes everything is worth nothing.
 */

import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M } from '@switchback/geo';
import {
  PARKING_BUFFER_M,
  WAYPOINT_BUFFER_M,
  attachWaypoints,
  classifyWaypoint,
  featurePosition,
  terminusFeatures,
} from '../../src/enrich';
import { FEATURE_CELL_M } from '../../src/feature-index';
import type { OverpassElement } from '../../src/overpass';
import type { Candidate } from './association';

const DEG = Math.PI / 180;

function positionOf(element: OverpassElement): LngLat | null {
  if (element.type === 'node') return [element.lon, element.lat];
  if (element.type === 'way' && element.center) return [element.center.lon, element.center.lat];
  return null;
}

/**
 * A uniform grid that looks only in the cells the trail's own vertices fall in — no neighbour
 * ring. Hits are restored to feature-query order first, so the missing ring is the only defect:
 * a reordering would turn the comparison red for a second reason and prove nothing about it.
 */
export const boundaryBlindGrid: Candidate = {
  name: 'mutant:boundary-blind-grid',
  build(features) {
    const cellDeg = WAYPOINT_BUFFER_M / (EARTH_RADIUS_M * DEG);
    const cells = new Map<string, number[]>();
    const cellOf = (at: LngLat): string =>
      `${Math.floor(at[0] / cellDeg)},${Math.floor(at[1] / cellDeg)}`;

    features.forEach((feature, index) => {
      const at = positionOf(feature);
      if (!at) return;
      const key = cellOf(at);
      const bucket = cells.get(key);
      if (bucket) bucket.push(index);
      else cells.set(key, [index]);
    });

    return {
      associate(coords) {
        const hits = new Set<number>();
        for (const vertex of coords) {
          for (const index of cells.get(cellOf(vertex)) ?? []) hits.add(index);
        }
        const near = [...hits].sort((a, b) => a - b).map((index) => features[index]!);
        return {
          waypoints: attachWaypoints(coords, near),
          termini: terminusFeatures(coords, near),
        };
      },
    };
  },
};

/** The off-by-epsilon case: a buffer one millimetre short of the real one, in 150 m. */
export const narrowBuffer: Candidate = {
  name: 'mutant:narrow-buffer',
  build: (features) => ({
    associate: (coords) => ({
      waypoints: attachWaypoints(coords, features, {
        bufferM: WAYPOINT_BUFFER_M - 1e-3,
        parkingBufferM: PARKING_BUFFER_M - 1e-3,
      }),
      termini: terminusFeatures(coords, features),
    }),
  }),
};

/**
 * The same features in the opposite order. Attaches the same set, but the dedupe key keeps
 * whichever duplicate it sees first and the sort is stable, so the output differs.
 */
export const reversedOrder: Candidate = {
  name: 'mutant:reversed-order',
  build(features) {
    const reversed = [...features].reverse();
    return {
      associate: (coords) => ({
        waypoints: attachWaypoints(coords, reversed),
        termini: terminusFeatures(coords, reversed),
      }),
    };
  },
};

/** Waypoints indexed, termini forgotten — the half of the work that has no visible output. */
export const terminusBlind: Candidate = {
  name: 'mutant:terminus-blind',
  build: (features) => ({
    associate: (coords) => ({
      waypoints: attachWaypoints(coords, features),
      termini: { start: [], end: [] },
    }),
  }),
};

/** One grid keyed at the waypoint radius, with parking's larger radius forgotten. */
export const parkingRadiusForgotten: Candidate = {
  name: 'mutant:parking-radius-forgotten',
  build: (features) => ({
    associate: (coords) => ({
      waypoints: attachWaypoints(coords, features, { parkingBufferM: WAYPOINT_BUFFER_M }),
      termini: terminusFeatures(coords, features),
    }),
  }),
};

/**
 * The shipped grid with the buffer padding taken out of its sweep: it looks in the cells the
 * trail's segments cross and no further. This is the one defect `sweep` exists to prevent, and
 * unlike `boundaryBlindGrid` it is built the way `buildFeatureIndex` is, so a boundary case that
 * stops catching it is telling you the case no longer straddles a cell line.
 */
export const unpaddedGrid: Candidate = {
  name: 'mutant:unpadded-grid',
  build(features) {
    const cellDeg = FEATURE_CELL_M / (EARTH_RADIUS_M * DEG);
    const kept: OverpassElement[] = [];
    const cells = new Map<string, number[]>();

    for (const element of features) {
      if (element.type !== 'node' && element.type !== 'way') continue;
      if (!classifyWaypoint(element.tags ?? {})) continue;
      const at = featurePosition(element);
      if (!at) continue;
      const index = kept.length;
      kept.push(element);
      const key = `${Math.floor(at[0] / cellDeg)},${Math.floor(at[1] / cellDeg)}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(index);
      else cells.set(key, [index]);
    }

    return {
      associate(coords) {
        const hits = new Set<number>();
        for (let i = 1; i < coords.length; i++) {
          const a = coords[i - 1]!;
          const b = coords[i]!;
          const lngLo = Math.floor(Math.min(a[0], b[0]) / cellDeg);
          const lngHi = Math.floor(Math.max(a[0], b[0]) / cellDeg);
          const latLo = Math.floor(Math.min(a[1], b[1]) / cellDeg);
          const latHi = Math.floor(Math.max(a[1], b[1]) / cellDeg);
          // Bounded so a segment across the antimeridian does not hang the mutant.
          if ((lngHi - lngLo + 1) * (latHi - latLo + 1) > cells.size) {
            for (const bucket of cells.values()) for (const index of bucket) hits.add(index);
            continue;
          }
          for (let x = lngLo; x <= lngHi; x++) {
            for (let y = latLo; y <= latHi; y++) {
              for (const index of cells.get(`${x},${y}`) ?? []) hits.add(index);
            }
          }
        }
        const near = [...hits].sort((a, b) => a - b).map((index) => kept[index]!);
        return {
          waypoints: attachWaypoints(coords, near),
          termini: terminusFeatures(coords, near),
        };
      },
    };
  },
};

export const mutants: readonly Candidate[] = [
  boundaryBlindGrid,
  unpaddedGrid,
  narrowBuffer,
  reversedOrder,
  terminusBlind,
  parkingRadiusForgotten,
];
