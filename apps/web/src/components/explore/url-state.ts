/**
 * The explore view, in the address bar.
 *
 * A map without this is a map you cannot send anyone. Someone finds the right ridge, the
 * right filters, the right trail — and the only way to pass it on is to describe it in
 * words. Every mapping product worth using puts the view in the URL, and the reason is not
 * bookmarking: it is that a link is how a plan gets from one person to another.
 *
 * **`map=z/lat/lng`, the OSM spelling.** Familiar, compact, and centre-plus-zoom rather
 * than a bounding box — a box copied from one screen shows a different area on the next,
 * because it has to letterbox to fit a different aspect ratio. A centre and a zoom mean the
 * same place on a phone as on a desktop.
 *
 * **Written with `replaceState`.** Panning a map is not navigation. Pushing an entry per
 * viewport would fill the history stack in one drag and turn the back button into an undo
 * for mouse movements, which is exactly the behaviour people complain about in map apps.
 * Deliberate moves — picking a place, opening a trail — are still ordinary links elsewhere
 * in the app; this file only mirrors state that the user changed by direct manipulation.
 */

import { ACTIVITY_TYPES, DIFFICULTIES, ROUTE_TYPES } from '@switchback/core';
import type { ActivityType, Difficulty, RouteType } from '@switchback/core';
import { BROWSE_SORTS, EMPTY_FACETS, type BrowseSort, type Facets } from './facets';

export interface ExploreView {
  center: [number, number];
  zoom: number;
}

export interface ExploreUrlState {
  view: ExploreView | null;
  query: string;
  trailId: string | null;
  facets: Facets;
}

/**
 * Decimal places kept in the URL.
 *
 * Five is about a metre — past the point where a shared link lands somewhere different, and
 * short enough that the whole parameter stays readable. Zoom keeps two, because fractional
 * zoom is real and `12` versus `12.4` is a visible difference in what fits on screen.
 */
const COORD_DP = 5;
const ZOOM_DP = 2;

function num(value: number, dp: number): string {
  return Number(value.toFixed(dp)).toString();
}

/** Parse `z/lat/lng`, rejecting anything off the globe rather than clamping it. */
function parseView(raw: string | null): ExploreView | null {
  if (!raw) return null;
  const parts = raw.split('/');
  if (parts.length !== 3) return null;

  const [zoom, lat, lng] = parts.map(Number) as [number, number, number];
  if (![zoom, lat, lng].every(Number.isFinite)) return null;
  if (zoom < 0 || zoom > 24) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { center: [lng, lat], zoom };
}

/**
 * Read a comma-separated list, keeping only values the app actually knows.
 *
 * A URL is user input and arrives from anywhere — an old link from before a value was
 * renamed, a typo, someone editing the address bar. Unknown values are dropped rather than
 * passed through, because `difficulty=extreme` reaching the API is a validation error for
 * something the user cannot see or fix, and an ignored filter is the gentler failure.
 */
function parseEnums<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const known = new Set<string>(allowed);
  return [...new Set(raw.split(',').filter((value) => known.has(value)))] as T[];
}

function parseRange(raw: string | null): { min?: number; max?: number } {
  if (!raw) return {};
  const [min, max] = raw.split('-').map((part) => (part === '' ? undefined : Number(part)));
  return {
    ...(min !== undefined && Number.isFinite(min) ? { min } : {}),
    ...(max !== undefined && Number.isFinite(max) ? { max } : {}),
  };
}

function parseFlag(raw: string | null): boolean | undefined {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return undefined;
}

/**
 * The whole explore state, read from a query string.
 *
 * Takes the search string rather than reading `window` so it is testable and so the caller
 * decides when it runs — this is mount-time state, and re-reading it on every render would
 * fight the user for control of their own map.
 */
export function parseExploreUrl(search: string): ExploreUrlState {
  const params = new URLSearchParams(search);
  const length = parseRange(params.get('len'));
  const gain = parseRange(params.get('gain'));
  const sort = params.get('sort');

  return {
    view: parseView(params.get('map')),
    query: params.get('q') ?? '',
    trailId: params.get('trail'),
    facets: {
      difficulty: parseEnums<Difficulty>(params.get('diff'), DIFFICULTIES),
      routeType: parseEnums<RouteType>(params.get('route'), ROUTE_TYPES),
      activityTypes: parseEnums<ActivityType>(params.get('act'), ACTIVITY_TYPES),
      ...(length.min !== undefined ? { minLengthM: length.min } : {}),
      ...(length.max !== undefined ? { maxLengthM: length.max } : {}),
      ...(gain.min !== undefined ? { minGainM: gain.min } : {}),
      ...(gain.max !== undefined ? { maxGainM: gain.max } : {}),
      ...(parseFlag(params.get('dogs')) !== undefined
        ? { dogsAllowed: parseFlag(params.get('dogs')) }
        : {}),
      ...(parseFlag(params.get('wheelchair')) !== undefined
        ? { wheelchairAccessible: parseFlag(params.get('wheelchair')) }
        : {}),
      sort: BROWSE_SORTS.includes(sort as BrowseSort) ? (sort as BrowseSort) : EMPTY_FACETS.sort,
    },
  };
}

function range(min: number | undefined, max: number | undefined): string | null {
  if (min === undefined && max === undefined) return null;
  return `${min ?? ''}-${max ?? ''}`;
}

/**
 * The inverse: state to a query string.
 *
 * Defaults are omitted rather than spelled out. A URL carrying every facet at its empty
 * value is unreadable and unshareable, and — more to the point — indistinguishable from one
 * where someone deliberately chose those values. What is in the URL should be what was
 * chosen.
 */
export function exploreUrlSearch(state: ExploreUrlState): string {
  const params = new URLSearchParams();
  const { view, facets } = state;

  if (view) {
    params.set(
      'map',
      `${num(view.zoom, ZOOM_DP)}/${num(view.center[1], COORD_DP)}/${num(view.center[0], COORD_DP)}`,
    );
  }
  if (state.query) params.set('q', state.query);
  if (state.trailId) params.set('trail', state.trailId);

  if (facets.difficulty.length) params.set('diff', facets.difficulty.join(','));
  if (facets.routeType.length) params.set('route', facets.routeType.join(','));
  if (facets.activityTypes.length) params.set('act', facets.activityTypes.join(','));

  const len = range(facets.minLengthM, facets.maxLengthM);
  if (len) params.set('len', len);
  const gain = range(facets.minGainM, facets.maxGainM);
  if (gain) params.set('gain', gain);

  if (facets.dogsAllowed !== undefined) params.set('dogs', facets.dogsAllowed ? '1' : '0');
  if (facets.wheelchairAccessible !== undefined) {
    params.set('wheelchair', facets.wheelchairAccessible ? '1' : '0');
  }
  if (facets.sort !== EMPTY_FACETS.sort) params.set('sort', facets.sort);

  return params.toString();
}
