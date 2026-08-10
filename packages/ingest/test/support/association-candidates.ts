/**
 * The two candidates the brief asks to be compared: an in-memory uniform grid, and a PostGIS
 * spatial join. Both are prefilters — the attach arithmetic stays in `enrich.ts` either way.
 */

import { attachWaypoints, terminusFeatures } from '../../src/enrich';
import { FEATURE_CELL_M, buildFeatureIndex } from '../../src/feature-index';
import type { OverpassElement } from '../../src/overpass';
import type { Candidate } from './association';

/** Candidate A. `cellM` is a parameter only so the benchmark can measure the constant's cost. */
export function gridCandidate(cellM: number = FEATURE_CELL_M): Candidate {
  return {
    name: cellM === FEATURE_CELL_M ? 'grid' : `grid@${cellM}m`,
    build(features: readonly OverpassElement[]) {
      const index = buildFeatureIndex(features, cellM);
      return {
        associate(coords) {
          const near = index.near(coords);
          return {
            waypoints: attachWaypoints(coords, near),
            termini: terminusFeatures(coords, near),
          };
        },
      };
    },
  };
}
