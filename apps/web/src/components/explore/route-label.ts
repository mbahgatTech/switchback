import type { RouteType } from '@switchback/core';

/**
 * What the three route shapes are called on screen. Shared by the filter chips and the cards:
 * "Out and back" in one place and "Out & back" in the other reads as two different things.
 */
export const ROUTE_LABEL: Record<RouteType, string> = {
  loop: 'Loop',
  out_and_back: 'Out and back',
  point_to_point: 'Point to point',
};
