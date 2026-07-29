/**
 * The facet vocabulary — what a viewport can be narrowed by.
 *
 * Separate from `filters.tsx` because two things need this and only one of them is a
 * component. The controls need it, and so does the URL codec, which has no business
 * importing a React tree to learn the shape of a query. Keeping the vocabulary in a plain
 * module means the codec can be unit-tested in a node environment without a renderer.
 */

import type { ActivityType, Difficulty, RouteType } from '@switchback/core';

/**
 * The orderings a map can express.
 *
 * A subset of `TrailSort`, and the omissions are the reason it is spelled out here rather
 * than reused: `relevance` needs a text query and `distance_from_me` needs a location, and
 * neither is something a viewport has. `trails.browse` enforces the same four.
 */
export type BrowseSort = 'popularity' | 'rating' | 'length_asc' | 'length_desc';

/** Every ordering, in one place, so the URL codec can reject anything else. */
export const BROWSE_SORTS: readonly BrowseSort[] = [
  'popularity',
  'rating',
  'length_asc',
  'length_desc',
];

export interface Facets {
  difficulty: Difficulty[];
  routeType: RouteType[];
  activityTypes: ActivityType[];
  minLengthM?: number;
  maxLengthM?: number;
  minGainM?: number;
  maxGainM?: number;
  dogsAllowed?: boolean;
  wheelchairAccessible?: boolean;
  sort: BrowseSort;
}

export const EMPTY_FACETS: Facets = {
  difficulty: [],
  routeType: [],
  activityTypes: [],
  sort: 'popularity',
};

/** How many facets are narrowing the results. Drives the "clear" affordance. */
export function activeFacetCount(facets: Facets): number {
  return (
    facets.difficulty.length +
    facets.routeType.length +
    facets.activityTypes.length +
    (facets.minLengthM !== undefined || facets.maxLengthM !== undefined ? 1 : 0) +
    (facets.minGainM !== undefined || facets.maxGainM !== undefined ? 1 : 0) +
    (facets.dogsAllowed === undefined ? 0 : 1) +
    (facets.wheelchairAccessible === undefined ? 0 : 1)
  );
}
