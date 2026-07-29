import type { RouteType } from '@switchback/core';

/**
 * What the three route shapes are called on screen.
 *
 * Shared by the filter chips and the cards deliberately: a reader who filters for "Out and
 * back" and then reads "Out & back" on the result has been told, quietly, that those might
 * be different things. One string, one place.
 */
export const ROUTE_LABEL: Record<RouteType, string> = {
  loop: 'Loop',
  out_and_back: 'Out and back',
  point_to_point: 'Point to point',
};
