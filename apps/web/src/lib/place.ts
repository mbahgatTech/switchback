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
 * 3. **Nothing.** Rendered as a question rather than as a guess. See `app/nearby/page.tsx`.
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

/**
 * Where the map opens when the reader has told us nothing at all.
 *
 * Seattle, and the honest version of the reason is narrower than "that is where the trails
 * are". `packages/db/scripts/seed.ts` seeds eight starter areas and **none of them is in
 * Washington**; the Washington content this catalogue actually holds is Mountain-Loop-shaped
 * — `seed-tracks.ts:66` is `[-121.75, 47.85, -121.25, 48.2]` and the whole e2e suite is built
 * around Vesper Peak — which is 60 km north-east of here and outside any frame that could
 * still be called Seattle. So this coordinate is the *city those hikes belong to*, not a
 * coordinate with hikes on it, and a reader who lands here with nothing cached gets the
 * ordinary on-demand ingest that any uncovered viewport gets.
 *
 * That is the premise worth re-checking before anyone defends this number: count the trails
 * within ~30 km of it. If the count is low, the lever is this one constant — move it east to
 * the I-90 corridor (Issaquah Alps, around `[-122.03, 47.53]`, still "Seattle" in plain
 * speech and where Washington day hikes actually are). It could not be counted when this was
 * written: the local Postgres was down and no other catalogue was reachable.
 */
export const FALLBACK_AT: LngLat = [-122.33, 47.61];

/** A zoom that trusts the coordinate: a GPS fix, or a place the reader searched for. */
const FIX_ZOOM = 11;

/**
 * A zoom that does not, used for both kinds of not-knowing.
 *
 * An IP lookup is city-accurate at best and the wrong side of a country on a VPN, so the
 * sheet opens one step wider — far enough out that a guess wrong by twenty kilometres still
 * has real trails on it, and wide enough to read as the hedge it is. `placeLabel` already
 * refuses to say "your location" for anything but a browser fix; this is the same honesty
 * spent on the camera, which is the only place the map has room to say it.
 *
 * The `null` case gets this zoom too, and that is not a hedge about the coordinate — it is
 * that we know strictly *less* about a reader with no cookie and no edge headers than about
 * one with an IP city, so handing the least-informed case the tighter frame is backwards. It
 * also buys the fallback its margin: at z11 a sheet centred on Seattle is a third salt water
 * and stops 10 km short of the nearest foothill, and at z10 the metro and the Issaquah Alps
 * are both on screen.
 *
 * Not wider than 10, and here is the actual arithmetic rather than the sketch that used to sit
 * here. `INGEST_ZOOM` is 9 and `MAX_TILES_PER_REQUEST` is 12 (`packages/geo/src/tiles.ts`), and
 * `ensureCoverage` returns `tooLarge` with nothing queued above that budget — which surfaces as
 * the coverage note and a "fetch this area" button instead of trails arriving on their own.
 * Feeding the explore sheet's real viewport (window width less the 416px collar, height less
 * the 48px neatline, centred on `FALLBACK_AT`) through `coverBBox` at z10 gives: 4 tiles at
 * 1400×900, 4 at 1920×1080, **8** at 2560×1440, **12 — exactly the cap** at 3840×2160, and 24
 * at 4800×2700. The note this replaces claimed "at most 3 tiles wide by 2 deep even on a
 * 2560px monitor"; it is 4 by 2 there, and anyone re-deriving the headroom from the old
 * sentence got half the real count.
 *
 * So the honest version: z10 is inside the budget on every mainstream desktop up to and
 * including a 4K monitor at 1× scaling, and goes over it beyond roughly 4,400 CSS pixels of
 * sheet — a 5K panel at dpr 1, or 4K with the browser zoomed out to 80%. There a first arrival
 * renders whatever is already catalogued and offers the fetch button rather than queueing by
 * itself. That is the designed degradation and not a broken page, but it is a degradation, and
 * it is the case to look at first if arrivals on very wide windows ever look empty.
 *
 * It is not fixed by picking a different constant, which is why one is still here. No
 * server-side number can be safe at an arbitrary viewport: the budget is spent by the *span*
 * the sheet covers, and the server cannot see the window. z11 would clear the cap at every
 * width — and cost every reader it applies to the frame this constant exists to give them. At
 * z11 the fallback sheet is a third salt water and stops short of the nearest foothill, so the
 * common case pays for the rare one. The levers, in order of how much they buy: move
 * `FALLBACK_AT` east to the I-90 corridor as its own note describes, so the tighter frame has
 * something in it; or derive the opening zoom from the sheet width on the client, which is the
 * only place the width is known.
 */
const GUESS_ZOOM = 10;

export interface PlaceCamera {
  center: LngLat;
  zoom: number;
}

/**
 * Where a map should open, given what we know about the reader — and how well we know it.
 *
 * Pure, and deliberately separate from `viewerPlace()`: this module imports `next/headers` at
 * module scope, so it can only be called on the server, and the answer has to cross into the
 * map as a serialized prop rather than as a call inside the client tree.
 */
export function placeCamera(place: ViewerPlace | null): PlaceCamera {
  if (place === null) return { center: FALLBACK_AT, zoom: GUESS_ZOOM };
  return { center: place.at, zoom: place.source === 'network' ? GUESS_ZOOM : FIX_ZOOM };
}
