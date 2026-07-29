import { z } from 'zod';
import {
  areaSummarySchema,
  bboxSchema,
  lngLatSchema,
  tileCoverageSchema,
  trailSearchSchema,
  trailSummarySchema,
} from './types';
import { UNIT_SYSTEMS } from './units';

/**
 * The wire between a map and whatever is holding it.
 *
 * On the phone the explore map is MapLibre GL JS inside a `WebView`, loading `/embed/map`
 * from the same server that serves the website. That is not a compromise, it is the reason
 * the two clients draw one cartography: `buildStyle` is a single function, the trail layers
 * are a single module, and a change to either lands on both without a second implementation
 * to keep in step. The alternative — `@maplibre/maplibre-react-native` — needs a development
 * build, which needs a Mac, and would have meant maintaining a parallel style in a second
 * language for the privilege.
 *
 * What a `WebView` gives us is one channel in each direction carrying strings. So the
 * protocol is declared here, in the package both sides already depend on, and validated on
 * receipt at both ends. Parsing rather than casting matters more than usual here: the two
 * halves are separately deployed. A phone running last week's bundle talks to today's page
 * and vice versa, and a message that no longer fits should be dropped by a `safeParse`
 * rather than crash a map somebody is standing on a hillside looking at.
 *
 * **The map fetches; the host presents.** The obvious division — host fetches, map draws —
 * is the wrong one here, and expensively so. `trails.browse` returns a simplified line per
 * trail, and a hundred and twenty of those is several hundred kilobytes. Sending them into
 * the page means serialising every polyline to a string, handing it to `injectJavaScript`,
 * and parsing it again, on every pan. So the page runs the query itself — it is served by
 * the same origin as the API and `browse` is public — and sends back the summaries with the
 * geometry stripped, which is what the sheet was going to display anyway. Geometry never
 * crosses this channel. The host still owns the *filters*, because those belong to controls
 * it draws.
 *
 * Naming is from the page's point of view — `MapOut` leaves the map, `MapIn` arrives at it.
 */

/**
 * The filters, without the viewport.
 *
 * Mirrors `browse`'s input minus everything the map supplies for itself: `bbox` is whatever
 * it happens to be looking at, and the paging fields have no meaning for a canvas. Kept in
 * sync by the call site rather than by hand — the page spreads this into `trails.browse`, so
 * a field that drifts is a type error there rather than a silent mismatch at runtime.
 */
export const mapQuerySchema = trailSearchSchema
  .omit({ bbox: true, near: true, radiusM: true, cursor: true, limit: true, sort: true })
  .extend({
    sort: z.enum(['popularity', 'rating', 'length_asc', 'length_desc']).default('popularity'),
  });
export type MapQuery = z.infer<typeof mapQuerySchema>;

/** Messages the map sends out to its host. */
export const mapOutSchema = z.discriminatedUnion('type', [
  /**
   * The style has loaded and the trail layers are on. Nothing sent before this is drawn,
   * so the host holds its first message until it arrives rather than posting into a page
   * that has no source to put it in yet.
   */
  z.object({ type: z.literal('ready') }),
  /** The viewport, after it has settled. `[w, s, e, n]`, matching `browse`'s input. */
  z.object({
    type: z.literal('viewport'),
    bbox: bboxSchema,
    zoom: z.number(),
    center: lngLatSchema,
  }),
  /**
   * What is in view, for the list beside the map.
   *
   * Summaries, not map items: the lines are already drawn on the canvas that fetched them,
   * and a sheet cannot render a polyline. This is the whole reason the query lives in the
   * page — see the header.
   */
  z.object({
    type: z.literal('results'),
    trails: z.array(trailSummarySchema),
    /** Matching trails in view before the map's own limit, so the sheet can say "of 340". */
    total: z.number().int().nonnegative(),
    coverage: tileCoverageSchema,
    area: areaSummarySchema.nullable(),
  }),
  /** Whether a fetch is in flight, so the sheet can say so instead of looking empty. */
  z.object({ type: z.literal('loading'), loading: z.boolean() }),
  /** A trail was tapped, or bare ground was, which clears the selection. */
  z.object({ type: z.literal('select'), trailId: z.string().nullable() }),
  /**
   * The map failed. Sent so the host can say *the map could not load* instead of showing a
   * blank rectangle for ever — the one failure a `WebView` cannot report on its own.
   */
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type MapOut = z.infer<typeof mapOutSchema>;

/** Messages the host sends in to the map. */
export const mapInSchema = z.discriminatedUnion('type', [
  /**
   * The filters to apply from now on. Carries a nonce so that re-submitting an identical
   * query — the "search this area" gesture — still forces a fetch.
   */
  z.object({ type: z.literal('query'), query: mapQuerySchema, nonce: z.number() }),
  /** Selection from the sheet, so tapping a row and tapping a line do the same thing. */
  z.object({ type: z.literal('select'), trailId: z.string().nullable() }),
  /**
   * Go here. Carries a nonce for the reason `MapFrame` does on the web: searching for a
   * place, panning away, then picking the same place again is an ordinary thing to do, and
   * a bare bbox makes the second pick indistinguishable from no event at all.
   */
  z.object({ type: z.literal('frame'), bbox: bboxSchema, nonce: z.number() }),
  /** Base map and shading, so the layer switcher on the phone drives the same style. */
  z.object({
    type: z.literal('basemap'),
    basemap: z.enum(['relief', 'satellite', 'topo']),
    hillshade: z.boolean(),
  }),
  /**
   * Which system to label summit heights in.
   *
   * Separate from `basemap` even though both end in `setStyle`, because they are answers to
   * different questions asked in different places — one is the layer switcher sitting on the
   * map, the other is a row in Settings two screens away. Folding them together would mean
   * the layer switcher has to know the current units to avoid resetting them, which is how a
   * preference gets quietly clobbered by an unrelated control.
   *
   * Sent as well as passed in the URL. The URL settles what the first frame reads, because a
   * message cannot arrive before the map exists; the message covers the case where Settings
   * is changed while the explore tab is still mounted behind it, which on a tab bar is the
   * ordinary case rather than the exotic one.
   */
  z.object({ type: z.literal('units'), units: z.enum(UNIT_SYSTEMS) }),
  /**
   * How much of the map is covered by something the host is drawing over it, in CSS pixels.
   *
   * The phone puts a search field above the map and a sheet across the bottom of it, so the
   * rectangle the user can actually see is not the rectangle MapLibre would fit to. Without
   * this, selecting a trail centres it neatly behind the sheet. It changes as the sheet is
   * dragged, which is why it is a message rather than a mount-time parameter.
   */
  z.object({ type: z.literal('padding'), top: z.number(), bottom: z.number() }),
  /**
   * Where the user is, in the survey plate — the only thing on this map drawn in it.
   *
   * The host owns the location permission because the permission belongs to the app, not to
   * a web page inside it: a `WebView` asking for geolocation prompts in the page's name and
   * on iOS is a separate grant from the one the recorder already holds. So the phone reads
   * its own position and posts it here, and the page only draws.
   */
  z.object({
    type: z.literal('locate'),
    position: lngLatSchema.nullable(),
    accuracyM: z.number().nullable(),
    /** Whether to move the camera as well as the dot. False for a passive update. */
    follow: z.boolean().default(false),
  }),
  /**
   * A finished line to draw over the map, in the contour plate — a recorded hike.
   *
   * The one exception to *geometry never crosses this channel*, and worth naming as one. The
   * rule exists because `browse` returns a simplified line per trail and a hundred of those
   * cross on every pan; a hike is one line, sent once, when a screen opens. What makes it an
   * exception rather than a violation is that the page cannot fetch this for itself: a
   * recording can be private, and the `WebView` carries no session — the app authenticates
   * with a bearer token the page has never seen. So the host, which is signed in, fetches it
   * and hands it over.
   *
   * Simplify before sending. A five-hour hike is several thousand fixes and none of the ones
   * a metre apart survive being drawn at four pixels wide.
   */
  z.object({
    type: z.literal('track'),
    /** `[[lng, lat], …]`. Empty takes the line off. */
    line: z.array(lngLatSchema),
    /** Frame the camera on it. False only when the host owns the camera itself. */
    fit: z.boolean().default(true),
  }),
]);
export type MapIn = z.infer<typeof mapInSchema>;

/**
 * Serialise and parse.
 *
 * Thin, and deliberately the only way either side touches the channel — a `postMessage`
 * built by hand somewhere else is how a protocol drifts. `parseMapIn`/`parseMapOut` return
 * `null` on anything they do not recognise, which is the behaviour every caller wants: a
 * message from a version that does not agree with this one is not an error to surface, it
 * is a message to ignore.
 */
export function encodeMapIn(message: MapIn): string {
  return JSON.stringify(message);
}

export function encodeMapOut(message: MapOut): string {
  return JSON.stringify(message);
}

/*
 * `unknown` as the declared input, not `T`.
 *
 * A schema carrying a `.default()` has an input type that differs from its output — `follow`
 * is optional going in and always present coming out — and `z.ZodType<T>` alone assumes the
 * two are the same. Widening the input is not a loosening: the value here came off a wire as
 * a string and was handed to `JSON.parse`, so `unknown` is exactly what it is.
 */
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseMapIn(raw: string): MapIn | null {
  return parse(mapInSchema, raw);
}

export function parseMapOut(raw: string): MapOut | null {
  return parse(mapOutSchema, raw);
}
