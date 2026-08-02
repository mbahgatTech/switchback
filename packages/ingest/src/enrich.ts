/**
 * Enrichment: waypoints and seed photographs around an assembled trail. Every function here
 * fails soft — a trail with neither is still a trail, and neither is worth failing a tile for.
 */

import type { BBox, LngLat, WaypointKind } from '@switchback/core';
import type { PlacedFeature, TerminusKinds } from '@switchback/geo';
import { nearestPointOnLine, padBBox, terminusKinds } from '@switchback/geo';
import type { OverpassElement } from './overpass';

/**
 * How far off the line a feature can be and still belong to this trail. 150 m for summits and
 * viewpoints — a peak node sits at the true summit, dozens of metres off the path that circles
 * it. Parking gets a larger radius: a trailhead car park is often up an access road.
 */
export const WAYPOINT_BUFFER_M = 150;
export const PARKING_BUFFER_M = 500;

export interface EnrichedWaypoint {
  kind: WaypointKind;
  name: string | null;
  lng: number;
  lat: number;
  /** Distance along the trail, or null for a feature that is near it but not on it. */
  distM: number | null;
  /** How far off the line the feature sits. Kept so the UI can say "200 m off-trail". */
  offsetM: number;
  /** The feature's own `ele` tag in metres — the peak's height, not the trail's beneath it. */
  osmEleM: number | null;
  osmType: 'node' | 'way';
  osmId: number;
  tags: Record<string, string>;
}

interface WaypointRule {
  kind: WaypointKind;
  match: (t: Record<string, string>) => boolean;
  /**
   * Whether a match at a line's endpoint is evidence about the *shape* of the hike. False for
   * kinds that only name one: `hasImpliedReturnLeg` doubles a trail's published distance and
   * ascent off this, so a rule joins the terminus vocabulary only on evidence it classifies well.
   */
  terminus?: false;
}

/**
 * OSM tag to our waypoint vocabulary. Ordered, first match wins: tags overlap, and a node
 * tagged `natural=spring` + `amenity=drinking_water` is better labelled "water" to a hiker.
 */
const WAYPOINT_RULES: WaypointRule[] = [
  { kind: 'summit', match: (t) => t.natural === 'peak' },
  { kind: 'viewpoint', match: (t) => t.tourism === 'viewpoint' },
  { kind: 'waterfall', match: (t) => t.waterway === 'waterfall' },
  { kind: 'lake', match: (t) => t.natural === 'water' && t.water !== 'river' },
  { kind: 'water', match: (t) => t.natural === 'spring' || t.amenity === 'drinking_water' },
  { kind: 'parking', match: (t) => t.amenity === 'parking' },
  { kind: 'toilets', match: (t) => t.amenity === 'toilets' },
  {
    kind: 'shelter',
    match: (t) =>
      t.amenity === 'shelter' || t.tourism === 'alpine_hut' || t.tourism === 'wilderness_hut',
  },
  { kind: 'campsite', match: (t) => t.tourism === 'camp_site' },
  { kind: 'ford', match: (t) => t.ford === 'yes' },
  { kind: 'gate', match: (t) => t.barrier === 'gate' || t.barrier === 'stile' },
  { kind: 'junction', match: (t) => t.information === 'guidepost' },
  { kind: 'hazard', match: (t) => t.natural === 'cave_entrance' },
  // Appended, not inserted: a rule above a narrower one steals from it, and `natural=saddle`
  // carrying `tourism=viewpoint` is a viewpoint today and stays one. All three are naming-only
  // — a hill classifies as `summit`, which `TERMINAL_DESTINATIONS` holds, and the route-type
  // classifier has never seen a hill node to be tuned against one.
  { kind: 'summit', match: (t) => t.natural === 'hill', terminus: false },
  {
    kind: 'pass',
    match: (t) => t.natural === 'saddle' || t.mountain_pass === 'yes',
    terminus: false,
  },
  { kind: 'glacier', match: (t) => t.natural === 'glacier', terminus: false },
];

/** The kind a feature is shown and named as. Every rule participates. */
export function classifyWaypoint(tags: Record<string, string>): WaypointKind | null {
  return matchRule(tags)?.kind ?? null;
}

/**
 * The kind a feature counts as *at an endpoint*, for the route-type classifier — null where
 * `classifyWaypoint` would answer but the rule is naming-only. A separate vocabulary because
 * the two questions have different costs: mislabelling a pin loses a hiker a label, and
 * mislabelling a terminus publishes a 5 km hike as 10 km.
 */
export function classifyTerminus(tags: Record<string, string>): WaypointKind | null {
  const rule = matchRule(tags);
  return rule && rule.terminus !== false ? rule.kind : null;
}

function matchRule(tags: Record<string, string>): WaypointRule | null {
  for (const rule of WAYPOINT_RULES) {
    if (rule.match(tags)) return rule;
  }
  return null;
}

/**
 * Metres from OSM's `ele`. Bare numbers only: the tag is defined as metres, and the handful
 * that carry `ft`, a range or prose are rejected rather than guessed at, since the summit
 * clause that reads this refuses when it is null and publishes a title when it is not.
 */
export function parseEleM(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?)\s*(?:m|metres|meters)?$/i.exec(value.trim());
  if (!match) return null;
  const metres = Number(match[1]);
  // The Dead Sea shore to a little above Everest. Outside that it is feet, a typo, or a fill value.
  return Number.isFinite(metres) && metres >= -500 && metres <= 9000 ? metres : null;
}

/** `out center` gives ways a synthetic centre point; nodes have their own position. */
function positionOf(element: OverpassElement): LngLat | null {
  if (element.type === 'node') return [element.lon, element.lat];
  if (element.type === 'way' && element.center) return [element.center.lon, element.center.lat];
  return null;
}

/**
 * Attach nearby OSM features to a trail line. `distM` is null past `WAYPOINT_BUFFER_M`,
 * because a car park 400 m away has no meaningful distance *along* the trail — and the
 * elevation chart plots by `distM`, so a parking pin at 0 m would sit on it as if hiked through.
 */
export function attachWaypoints(
  coords: readonly LngLat[],
  elements: readonly OverpassElement[],
  options: { bufferM?: number; parkingBufferM?: number } = {},
): EnrichedWaypoint[] {
  const bufferM = options.bufferM ?? WAYPOINT_BUFFER_M;
  const parkingBufferM = options.parkingBufferM ?? PARKING_BUFFER_M;
  if (coords.length < 2) return [];

  const out: EnrichedWaypoint[] = [];
  const seen = new Set<string>();

  for (const element of elements) {
    if (element.type !== 'node' && element.type !== 'way') continue;
    const tags = element.tags ?? {};
    const kind = classifyWaypoint(tags);
    if (!kind) continue;

    const position = positionOf(element);
    if (!position) continue;

    const nearest = nearestPointOnLine(position, coords);
    const limit = kind === 'parking' ? parkingBufferM : bufferM;
    if (nearest.distM > limit) continue;

    // A named summit tagged on both a node and its surrounding area appears twice.
    const dedupeKey = `${kind}:${tags.name ?? ''}:${position[0].toFixed(4)},${position[1].toFixed(4)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      kind,
      name: tags.name ?? tags['name:en'] ?? null,
      lng: position[0],
      lat: position[1],
      distM: nearest.distM <= bufferM ? nearest.alongM : null,
      offsetM: Math.round(nearest.distM),
      osmEleM: parseEleM(tags.ele),
      osmType: element.type,
      osmId: element.id,
      tags,
    });
  }

  // Along the trail first, so the detail page reads as a hike rather than a tag dump.
  out.sort((a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity));
  return out;
}

/**
 * What sits at each end of the line, for the route-type classifier. A separate pass from
 * `attachWaypoints` because the two measure different things: a waypoint's `distM` runs
 * *along* the trail, which puts a summit 40 m past the last vertex at the line's full length.
 * `terminusKinds` measures straight-line distance from the endpoint, which is the question.
 *
 * Reads `classifyTerminus`, not `classifyWaypoint`: naming-only kinds are excluded here.
 *
 * Runs on the stored, un-oriented geometry, which is safe: `hasImpliedReturnLeg` asks only
 * whether *exactly one* end is a destination, and does not care which end is which.
 */
export function terminusFeatures(
  coords: readonly LngLat[],
  elements: readonly OverpassElement[],
): TerminusKinds {
  const placed: PlacedFeature[] = [];

  for (const element of elements) {
    if (element.type !== 'node' && element.type !== 'way') continue;
    const kind = classifyTerminus(element.tags ?? {});
    if (!kind) continue;
    const at = positionOf(element);
    if (at) placed.push({ at, kind });
  }

  return terminusKinds(coords, placed);
}

/**
 * The trailhead, synthesised rather than found: `highway=trailhead` is rare outside North
 * America. For a loop the start is wherever the mapper began drawing, which is arbitrary but
 * still what every other distance is measured from — honest as long as we do not call it a
 * car park.
 */
export function synthesiseTrailhead(coords: readonly LngLat[]): EnrichedWaypoint | null {
  const start = coords[0];
  if (!start) return null;
  return {
    kind: 'trailhead',
    name: null,
    lng: start[0],
    lat: start[1],
    distM: 0,
    offsetM: 0,
    osmEleM: null,
    osmType: 'node',
    osmId: 0,
    tags: {},
  };
}

/**
 * Total parking capacity near the trail, for the busyness model. Returns null rather than 0
 * when nothing is known — `capacity` is untagged more often than not, and the model treats
 * "no spaces" and "unknown" differently.
 */
export function parkingCapacity(waypoints: readonly EnrichedWaypoint[]): number | null {
  let total = 0;
  let known = false;
  for (const waypoint of waypoints) {
    if (waypoint.kind !== 'parking') continue;
    const capacity = Number(waypoint.tags.capacity);
    if (Number.isFinite(capacity) && capacity > 0) {
      total += capacity;
      known = true;
    }
  }
  return known ? total : null;
}

export interface SeedPhoto {
  url: string;
  thumbUrl: string;
  width: number | null;
  height: number | null;
  lng: number | null;
  lat: number | null;
  /** Stored per photo, not per source: Commons carries a dozen different licences. */
  license: string | null;
  attribution: string | null;
  sourceUrl: string;
  source: 'wikimedia' | 'mapillary';
  externalId: string;
}

export interface PhotoSourceOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  limit?: number;
  timeoutMs?: number;
}

interface CommonsPage {
  pageid: number;
  title: string;
  imageinfo?: Array<{
    url: string;
    thumburl?: string;
    width?: number;
    height?: number;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }>;
  coordinates?: Array<{ lat: number; lon: number }>;
}

/**
 * Space agencies. Both the case-sensitivity and the Unicode look-arounds are load-bearing:
 * `\b` is ASCII-only and a loose `/ESA/` finds Teresa, Mesa and Chiesa, while an `/i` flag
 * would delete Esa-Pekka Salonen. The agencies write themselves in capitals every time.
 */
const ORBITAL_AGENCY = /(?<![\p{L}\p{N}])(?:NASA|ESA|JAXA|MODIS)(?![\p{L}\p{N}])/u;

/**
 * Earth-observation programmes. Three entries carry a qualifier against real trail subjects:
 * Goddard is a surname, Aster is a trailside wildflower, and Sentinel Dome in Yosemite is one
 * of the most photographed viewpoints in the corpus. USGS is deliberately absent — it is a
 * *ground* survey agency whose Commons corpus is nearly a description of this product.
 */
const ORBITAL_PROGRAMME =
  /remote sensing|earth science|earth observatory|johnson space|goddard space|copernicus|landsat|sentinel-\d|aster science/i;

/**
 * Astronaut-photography frame designators (`ISS042-E-107916`, `STS061A-101-005`). Machine
 * identifiers, so they collide with nothing — matching a mission *word* instead would delete
 * every photograph taken from Sentinel Dome. Matched against the raw basename, which needs no
 * decoding: a designator is ASCII, and `decodeURIComponent` throws on the malformed escapes
 * Commons filenames occasionally carry.
 */
const ORBITAL_FRAME = /^(?:iss\d+(?:-e-|e)\d+|sl\d+-\d+-\d+|sts\d+|as\d+-\d+-\d+)/i;

/**
 * Is this a picture of the Earth from space rather than of somewhere on it? Commons geosearch
 * tags an astronaut's photograph of the Cascades with the coordinates of the Cascades, and
 * nothing in the response distinguishes the two. Two independent tests, either sufficient: the
 * credit catches Landsat and ASTER scenes, the designator catches astronaut photography whose
 * credit is missing or simply says `NASA`.
 */
export function isOrbitalImagery(photo: { url: string; attribution?: string | null }): boolean {
  const credit = photo.attribution ?? '';
  if (ORBITAL_AGENCY.test(credit) || ORBITAL_PROGRAMME.test(credit)) return true;
  return ORBITAL_FRAME.test(photo.url.split('/').pop() ?? '');
}

/**
 * Wikimedia Commons geosearch. One request: `generator=geosearch` finds files near a point and
 * `prop=imageinfo` returns their URLs and licence metadata in the same response. `gsradius`
 * caps at 10 km on the API side. Preferred over Mapillary because its images are curated and
 * attributed, where Mapillary's are street-level captures that make poor hero photos.
 */
export async function fetchCommonsPhotos(
  centroid: LngLat,
  radiusM: number,
  options: PhotoSourceOptions = {},
): Promise<SeedPhoto[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limit = options.limit ?? 12;

  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'geosearch',
    ggscoord: `${centroid[1]}|${centroid[0]}`,
    ggsradius: String(Math.min(Math.max(Math.round(radiusM), 10), 10_000)),
    ggslimit: String(limit),
    ggsnamespace: '6', // File:
    prop: 'imageinfo|coordinates',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '1600',
    iiextmetadatafilter: 'LicenseShortName|Artist|Credit|LicenseUrl',
  }).toString();

  const body = await getJson<{ query?: { pages?: CommonsPage[] } }>(
    url.toString(),
    options,
    fetchImpl,
  );
  if (!body?.query?.pages) return [];

  const photos: SeedPhoto[] = [];
  for (const page of body.query.pages) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    // Commons hosts maps, diagrams and scanned documents alongside photographs.
    if (!/\.(jpe?g|png|webp)$/i.test(info.url)) continue;

    const meta = info.extmetadata ?? {};
    const attribution = stripHtml(meta.Artist?.value ?? meta.Credit?.value) ?? null;
    // ...and a great deal of the Earth as seen from orbit, tagged with the coordinates of the
    // ground it shows, which geosearch cannot tell from a photograph taken standing on it.
    if (isOrbitalImagery({ url: info.url, attribution })) continue;

    const coordinate = page.coordinates?.[0];
    photos.push({
      url: info.url,
      thumbUrl: info.thumburl ?? info.url,
      width: info.width ?? null,
      height: info.height ?? null,
      lng: coordinate?.lon ?? null,
      lat: coordinate?.lat ?? null,
      license: stripHtml(meta.LicenseShortName?.value) ?? null,
      attribution,
      sourceUrl: info.descriptionurl ?? `https://commons.wikimedia.org/?curid=${page.pageid}`,
      source: 'wikimedia',
      externalId: String(page.pageid),
    });
  }
  return photos;
}

/**
 * Mapillary, as a fallback where Commons has nothing. Without `MAPILLARY_TOKEN` this returns
 * empty rather than throwing: a missing optional key should degrade the product, not break the
 * pipeline. Images are CC-BY-SA 4.0 and the attribution is stored with each one.
 */
export async function fetchMapillaryPhotos(
  bbox: BBox,
  token: string | undefined,
  options: PhotoSourceOptions = {},
): Promise<SeedPhoto[]> {
  if (!token) return [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limit = options.limit ?? 8;
  const [w, s, e, n] = bbox;

  const url = new URL('https://graph.mapillary.com/images');
  url.search = new URLSearchParams({
    access_token: token,
    bbox: `${w},${s},${e},${n}`,
    fields: 'id,thumb_1024_url,thumb_2048_url,computed_geometry,captured_at',
    limit: String(limit),
  }).toString();

  const body = await getJson<{
    data?: Array<{
      id: string;
      thumb_1024_url?: string;
      thumb_2048_url?: string;
      computed_geometry?: { coordinates?: [number, number] };
    }>;
  }>(url.toString(), options, fetchImpl);

  return (body?.data ?? [])
    .filter((image) => Boolean(image.thumb_1024_url))
    .map((image) => ({
      url: image.thumb_2048_url ?? image.thumb_1024_url!,
      thumbUrl: image.thumb_1024_url!,
      width: null,
      height: null,
      lng: image.computed_geometry?.coordinates?.[0] ?? null,
      lat: image.computed_geometry?.coordinates?.[1] ?? null,
      license: 'CC BY-SA 4.0',
      attribution: 'Mapillary contributors',
      sourceUrl: `https://www.mapillary.com/app/?pKey=${image.id}`,
      source: 'mapillary' as const,
      externalId: image.id,
    }));
}

/**
 * Photos for one trail, Commons first. Mapillary only runs when Commons came back thin: two
 * mediocre street-level frames are worse than one good photograph.
 */
export async function fetchSeedPhotos(
  input: { centroid: LngLat; bbox: BBox; lengthM: number },
  options: PhotoSourceOptions & { mapillaryToken?: string } = {},
): Promise<SeedPhoto[]> {
  // Search radius scales with the trail — a 20 km route's photos are not all within 500 m of
  // its midpoint. Capped at the API's own 10 km limit.
  const radiusM = Math.min(Math.max(input.lengthM / 2, 500), 10_000);
  const commons = await fetchCommonsPhotos(input.centroid, radiusM, options);
  if (commons.length >= 3) return commons;

  const mapillary = await fetchMapillaryPhotos(input.bbox, options.mapillaryToken, options);
  return [...commons, ...mapillary];
}

/** The bbox to search for features around a trail, padded by the waypoint buffer. */
export function featureSearchBBox(bbox: BBox): BBox {
  return padBBox(bbox, PARKING_BUFFER_M);
}

/**
 * Fetch JSON, swallowing everything. Enrichment is decoration: an outage, a malformed response
 * or a timeout must not cost a tile of trails that are otherwise complete.
 */
async function getJson<T>(
  url: string,
  options: PhotoSourceOptions,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** Commons `extmetadata` values are HTML fragments — an `<a>` around the author's name. */
function stripHtml(value: string | undefined): string | null {
  if (!value) return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}
