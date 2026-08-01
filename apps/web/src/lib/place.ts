import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import type { LngLat } from '@switchback/core';

/**
 * Where the reader is on a server render, ranked: the place cookie they set, else Vercel's edge
 * geo headers, else nothing. The name travels with the coordinate — there is no reverse geocoder.
 */

/** Ninety days: a monthly visitor is never re-prompted, someone who moved is not stuck for a year. */
export const PLACE_COOKIE = 'sb-place';
export const PLACE_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

/** How we came to believe it: "near you" is true of a GPS fix and false of an IP lookup. */
export type PlaceSource = 'browser' | 'search' | 'network';

export interface ViewerPlace {
  at: LngLat;
  source: PlaceSource;
  /** "Cardiff", "Vesper Peak". Absent for a browser fix — a GPS reading has no name. */
  name?: string;
}

const SOURCES: readonly PlaceSource[] = ['browser', 'search', 'network'];

/** Six decimal places is ~11 cm; beyond that is noise stored as precision. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * A coordinate parsed from text, or null. Absence is rejected before the number is looked at:
 * `Number('')` and `Number(null)` are both 0, a valid longitude and latitude (Null Island).
 */
function coord(text: string | null | undefined, limit: 90 | 180): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < -limit || value > limit) return null;
  return value;
}

/** `lng,lat,source,name` — name last, so the one field that may hold a comma needs no escaping. */
export function formatPlaceCookie(place: ViewerPlace): string {
  const [lng, lat] = place.at;
  const head = `${round6(lng)},${round6(lat)},${place.source}`;
  return place.name ? `${head},${place.name}` : head;
}

/**
 * Every field re-derived, because a cookie is attacker-controlled text that reaches a PostGIS
 * query. Anything malformed reads as absent, degrading to the network guess.
 */
export function parsePlaceCookie(value: string | undefined): ViewerPlace | null {
  if (!value) return null;

  const parts = value.split(',');
  const lng = coord(parts[0], 180);
  const lat = coord(parts[1], 90);
  if (lng === null || lat === null) return null;

  const source = parts[2];
  if (!SOURCES.includes(source as PlaceSource)) return null;

  // Rejoined, because a name may legitimately contain the separator: "Cardiff, Wales".
  const name = parts.slice(3).join(',').trim().slice(0, 80);
  return { at: [lng, lat], source: source as PlaceSource, ...(name ? { name } : {}) };
}

/**
 * Vercel's edge geo headers. Absent off Vercel, so localhost renders the empty state rather
 * than an invented one. The city arrives percent-encoded — header values are Latin-1, "Zürich".
 */
function fromHeaders(bag: Headers): ViewerPlace | null {
  const lat = coord(bag.get('x-vercel-ip-latitude'), 90);
  const lng = coord(bag.get('x-vercel-ip-longitude'), 180);
  if (lng === null || lat === null) return null;

  const raw = bag.get('x-vercel-ip-city');
  let name: string | undefined;
  if (raw) {
    try {
      name = decodeURIComponent(raw).trim().slice(0, 80) || undefined;
    } catch {
      name = undefined;
    }
  }

  return { at: [lng, lat], source: 'network', ...(name ? { name } : {}) };
}

/** `cache()`d so a page that asks twice — the list, and the line saying where "here" is — agrees. */
export const viewerPlace = cache(async (): Promise<ViewerPlace | null> => {
  const [jar, bag] = await Promise.all([cookies(), headers()]);
  return parsePlaceCookie(jar.get(PLACE_COOKIE)?.value) ?? fromHeaders(bag);
});

/** Each label is true of its source and no stronger; only a browser fix earns "your location". */
export function placeLabel(place: ViewerPlace): string {
  if (place.source === 'browser') return 'your location';
  return place.name ?? 'here';
}

/**
 * Where the map opens when the reader has told us nothing. Seattle is the city Washington's
 * seeded hikes belong to, not a coordinate with trails on it — a first arrival here gets the
 * ordinary on-demand ingest. If arrivals look empty, move this east to the I-90 corridor
 * (~`[-122.03, 47.53]`, the Issaquah Alps) before reaching for the zoom below.
 */
export const FALLBACK_AT: LngLat = [-122.33, 47.61];

/** A zoom that trusts the coordinate: a GPS fix, or a place the reader searched for. */
const FIX_ZOOM = 11;

/**
 * For an IP city and for knowing nothing at all — the least-informed case must not get the
 * tighter frame. Not wider than 10 either: `coverBBox` over the explore sheet reaches
 * `MAX_TILES_PER_REQUEST` (12) at 4K, and past ~4,400 CSS px `ensureCoverage` returns `tooLarge`,
 * so a first arrival gets the "fetch this area" button instead of trails queueing on their own.
 */
const GUESS_ZOOM = 10;

export interface PlaceCamera {
  center: LngLat;
  zoom: number;
}

/**
 * Where a map should open, given what is known. Pure and deliberately separate from
 * `viewerPlace()`, which imports `next/headers`: the answer crosses into the client tree as a
 * serialized prop, not as a call.
 */
export function placeCamera(place: ViewerPlace | null): PlaceCamera {
  if (place === null) return { center: FALLBACK_AT, zoom: GUESS_ZOOM };
  return { center: place.at, zoom: place.source === 'network' ? GUESS_ZOOM : FIX_ZOOM };
}
