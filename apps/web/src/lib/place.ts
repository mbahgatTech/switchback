import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import type { LngLat } from '@switchback/core';

/**
 * Where the reader is, as far as the server can tell before the first byte.
 *
 * A "trails near you" page has a problem no other page here has: the server renders it and
 * the server does not know where you are. The three ways out are all wrong on their own —
 * a permission prompt on first paint asks for a coordinate before showing anything worth
 * the coordinate; a client-only fetch means the page arrives empty and fills in a beat
 * later; a hard-coded centre is a lie. So all three answers are ranked instead, and the
 * page says which one it used.
 *
 * 1. **The cookie.** Somebody pressed "Use my location", or searched a place. An answer a
 *    person gave, so it outranks anything inferred, and it is what makes the second visit
 *    instant with no prompt at all.
 * 2. **The connection.** Vercel resolves the edge request's IP to a city and hands it over
 *    in request headers. City-accurate at best, occasionally the wrong side of a country
 *    on a VPN — but it costs nothing, it is already in the request, and it is enough to
 *    put real trails on the page in the first paint.
 * 3. **Nothing.** Rendered as a question rather than as a guess. See `app/page.tsx`.
 *
 * There is deliberately no reverse geocoder here. Naming a coordinate would mean a
 * Nominatim round trip on every landing-page render against a shared public gazetteer that
 * permits one request per second — so the name travels with the coordinate instead: from
 * the header for a network guess, from the search result for a searched place, and not at
 * all for a browser fix, which genuinely has no name and is labelled "your location".
 */

/**
 * Ninety days. Long enough that a person who visits monthly is never asked twice, short
 * enough that somebody who has moved is not still being shown their old city a year later.
 */
export const PLACE_COOKIE = 'sb-place';
export const PLACE_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

/**
 * How we came to believe this, which is the only thing that licenses what the page says
 * about it. "Near you" is true of a GPS fix and false of an IP lookup, and a page that says
 * it anyway is the reason people distrust "near me" lists.
 */
export type PlaceSource = 'browser' | 'search' | 'network';

export interface ViewerPlace {
  at: LngLat;
  source: PlaceSource;
  /** "Cardiff", "Vesper Peak". Absent for a browser fix — a GPS reading has no name. */
  name?: string;
}

const SOURCES: readonly PlaceSource[] = ['browser', 'search', 'network'];

/** Six decimal places is ~11 cm. Anything beyond it is noise being stored as precision. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * A coordinate read out of text, or `null` if the text was not one.
 *
 * `Number()` is the trap this exists to avoid: `Number(null)` and `Number('')` are both
 * **0**, and 0 is a valid longitude and a valid latitude. So a missing header and an empty
 * cookie field both pass a naive range check and land the reader in the Gulf of Guinea —
 * "trails near Null Island", rendered with complete confidence. Absence has to be rejected
 * before the number is looked at, not after.
 */
function coord(text: string | null | undefined, limit: 90 | 180): number | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < -limit || value > limit) return null;
  return value;
}

/**
 * `lng,lat,source,name` — the name last because it is the only field that may contain a
 * comma, so it takes whatever remains and never needs escaping.
 */
export function formatPlaceCookie(place: ViewerPlace): string {
  const [lng, lat] = place.at;
  const head = `${round6(lng)},${round6(lat)},${place.source}`;
  return place.name ? `${head},${place.name}` : head;
}

/**
 * A cookie is attacker-controlled text that arrives on a server render and is fed to a
 * PostGIS query, so every field is re-derived rather than trusted. Anything malformed is
 * treated as absent, which degrades to the network guess and then to the question.
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
 * The geo headers Vercel adds at the edge.
 *
 * Only set on Vercel — locally they are absent and this returns null, which is correct
 * rather than a gap: `localhost` has no meaningful IP location, and inventing one for
 * development would hide the empty state from the person building it.
 *
 * The city arrives percent-encoded, because header values are Latin-1 and city names are
 * not ("Zürich", "München"). A malformed encoding decodes to a throw, so it is caught and
 * dropped: a coordinate with no name still renders, and it is the coordinate that matters.
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

/**
 * `cache()`d for the same reason `currentTheme` is: a page may ask more than once — the
 * list asks, and the line above it that says where "here" is asks again — and both should
 * see one answer from one read of the request.
 */
export const viewerPlace = cache(async (): Promise<ViewerPlace | null> => {
  const [jar, bag] = await Promise.all([cookies(), headers()]);
  return parsePlaceCookie(jar.get(PLACE_COOKIE)?.value) ?? fromHeaders(bag);
});

/**
 * How the page is allowed to describe where it is looking.
 *
 * Each string is written to be true of its source and no stronger. A network guess says
 * "near" and names the city so a reader who is not in it can see immediately that we are
 * wrong; a browser fix has earned "your location" and nothing else has.
 */
export function placeLabel(place: ViewerPlace): string {
  if (place.source === 'browser') return 'your location';
  return place.name ?? 'here';
}
