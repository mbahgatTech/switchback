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
 * The typed message protocol between the iOS `WebView` host and the MapLibre page at
 * `/embed/map`. The two halves deploy separately and neither typechecks against the other, so
 * every message is `safeParse`d on receipt and dropped if it does not fit.
 *
 * **The map fetches; the host presents.** The page runs `trails.browse` itself and returns
 * summaries with geometry stripped — polylines must not cross a string channel on every pan.
 * `track` is the one deliberate exception. Rationale in `docs/architecture.md`.
 */

/** The filters, minus the viewport. The page spreads this into `trails.browse`, so drift is a
 * type error there rather than a runtime mismatch. */
export const mapQuerySchema = trailSearchSchema
  .omit({ bbox: true, near: true, radiusM: true, cursor: true, limit: true, sort: true })
  .extend({
    sort: z.enum(['popularity', 'rating', 'length_asc', 'length_desc']).default('popularity'),
  });
export type MapQuery = z.infer<typeof mapQuerySchema>;

/** Messages the map sends out to its host. */
export const mapOutSchema = z.discriminatedUnion('type', [
  /** Style loaded, trail layers on. The host holds its first message until this arrives. */
  z.object({ type: z.literal('ready') }),
  /** The viewport, after it has settled. `[w, s, e, n]`, matching `browse`'s input. */
  z.object({
    type: z.literal('viewport'),
    bbox: bboxSchema,
    zoom: z.number(),
    center: lngLatSchema,
  }),
  /** What is in view, for the list beside the map. Summaries only — see the header. */
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
  /** The map failed — the one failure a `WebView` cannot report on its own. */
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type MapOut = z.infer<typeof mapOutSchema>;

/** Messages the host sends in to the map. */
export const mapInSchema = z.discriminatedUnion('type', [
  /** Filters to apply from now on. The nonce makes "search this area" re-fetch unchanged filters. */
  z.object({ type: z.literal('query'), query: mapQuerySchema, nonce: z.number() }),
  /** Selection from the sheet, so tapping a row and tapping a line do the same thing. */
  z.object({ type: z.literal('select'), trailId: z.string().nullable() }),
  /** Go here. Nonced as `query` is: picking the same place twice must not look like no event. */
  z.object({ type: z.literal('frame'), bbox: bboxSchema, nonce: z.number() }),
  /** Base map and shading, so the layer switcher on the phone drives the same style. */
  z.object({
    type: z.literal('basemap'),
    basemap: z.enum(['relief', 'satellite', 'topo']),
    hillshade: z.boolean(),
  }),
  /** Which system to label summit heights in. Separate from `basemap` despite both ending in
   * `setStyle`, so the layer switcher cannot clobber a Settings preference. Sent as well as
   * passed in the URL: the URL settles the first frame, the message covers a later change. */
  z.object({ type: z.literal('units'), units: z.enum(UNIT_SYSTEMS) }),
  /** How much of the map the host draws over, in CSS pixels, so MapLibre fits to what the user
   * can see. A message, not a mount-time parameter: it changes as the sheet is dragged. */
  z.object({ type: z.literal('padding'), top: z.number(), bottom: z.number() }),
  /** Where the user is, in the survey plate. The host reads the position and the page only
   * draws: a `WebView` geolocation prompt asks in the page's name and is a separate iOS grant. */
  z.object({
    type: z.literal('locate'),
    position: lngLatSchema.nullable(),
    accuracyM: z.number().nullable(),
    /** Whether to move the camera as well as the dot. False for a passive update. */
    follow: z.boolean().default(false),
  }),
  /** A recorded hike drawn over the map, in the contour plate. The one exception to *geometry
   * never crosses this channel*: a recording can be private and the `WebView` carries no
   * session, so the page cannot fetch it itself. Simplify before sending. */
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
 * Serialise and parse — the only way either side touches the channel; a hand-built `postMessage`
 * elsewhere is how a protocol drifts. The parsers return `null` on anything unrecognised.
 */
export function encodeMapIn(message: MapIn): string {
  return JSON.stringify(message);
}

export function encodeMapOut(message: MapOut): string {
  return JSON.stringify(message);
}

/*
 * `unknown` as the declared input, not `T`: a schema with a `.default()` has an input type
 * that differs from its output, which `z.ZodType<T>` alone assumes it does not.
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
