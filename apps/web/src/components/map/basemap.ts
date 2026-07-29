import type { ExpressionSpecification, SkySpecification, StyleSpecification } from 'maplibre-gl';
import { ATTRIBUTION, METRES_PER_FOOT, type UnitSystem } from '@switchback/core';
import { ELEVATION_BANDS, SCHEMES } from '@switchback/ui';
import { TERRARIUM_URL_TEMPLATE } from '@switchback/geo';
import { SLOPE_LAYER, SLOPE_SOURCE, SLOPE_TILE_URL, SLOPE_TILE_ZOOM } from './slope';

/**
 * The base map.
 *
 * **We draw our own.** Every other option here was a hosted basemap with a key, a quota,
 * and a house style — and a trail app wearing a generic road-map skin is the thing this
 * product is explicitly not. So the default base is a relief sheet rendered from the very
 * same terrarium DEM the elevation pipeline already decodes: a hypsometric tint under a
 * hillshade, which is how a survey sheet has shown ground since long before any of this.
 *
 * Three things fall out of that, and each one is why this is the right call rather than a
 * clever one:
 *
 * - **No key, no quota, no vendor.** AWS's Terrain Tiles are public and unmetered. The map
 *   cannot be rate-limited out from under the product, and there is no signup between a
 *   clone of this repo and a working map.
 * - **The palette is already ours.** `ELEVATION_BANDS` is a hypsometric ramp that was
 *   written for the elevation profile. Pointing a map layer at it costs nothing and makes
 *   the ground under a trail and the chart beneath it the same colour by construction.
 * - **It is the honest picture.** Relief is what decides whether a hike is hard. A road map
 *   showing a footpath as a thin dashed line tells a hiker almost nothing; shaded ground
 *   tells them where the climb is before they read a single number.
 *
 * Satellite is Esri's World Imagery, which is free with attribution. Topo is a vector sheet:
 * Protomaps over PMTiles where a deployment hosts its own archive, and OpenFreeMap's
 * OpenMapTiles build otherwise — keyless either way, so the option is always there.
 *
 * Every base then carries the same **reference overlay** on top: hydrography, the road and
 * path network, place names, and named summits with their heights. Relief and satellite are
 * wordless by construction, and a map you cannot read a name off is not finished.
 */

/** The three bases, in switcher order. */
export type BasemapId = 'relief' | 'satellite' | 'topo';

export interface BasemapMeta {
  id: BasemapId;
  label: string;
  /** One line, shown under the label in the switcher. Says what it is good for. */
  hint: string;
}

export const BASEMAPS: readonly BasemapMeta[] = [
  { id: 'relief', label: 'Relief', hint: 'Shaded ground and elevation tint' },
  { id: 'satellite', label: 'Satellite', hint: 'Esri imagery — tree cover, scree, snow' },
  { id: 'topo', label: 'Topo', hint: 'Flat sheet — paths, water and names, no shading' },
] as const;

/**
 * Where the Protomaps basemap lives, if anywhere.
 *
 * `NEXT_PUBLIC_` because MapLibre fetches it from the browser, and a public tile URL is not
 * a secret. Read through a function rather than at module scope so the value is inlined by
 * Next at build time in exactly one place.
 *
 * The placeholder in `.env.example` is rejected as firmly as an empty string. A fresh clone
 * copies that file verbatim, so the common case is a URL that is *set* but points at a host
 * that does not resolve — which is precisely the "option that opens a broken map" the
 * switcher is written to avoid, arriving through the one door a truthiness check leaves open.
 */
const PLACEHOLDER_HOSTS = ['cdn.example.com', 'example.com'];

export function pmtilesUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_PMTILES_URL?.trim();
  if (!url) return null;
  try {
    if (PLACEHOLDER_HOSTS.includes(new URL(url).hostname)) return null;
  } catch {
    // Not a parseable URL, so it cannot be fetched either.
    return null;
  }
  return url;
}

/**
 * Where the OpenMapTiles-schema vector tiles come from.
 *
 * Defaults to OpenFreeMap, which serves a planet-wide OpenMapTiles build with no key, no
 * quota and no signup — the same bar the terrarium DEM clears, which is why it is allowed
 * to be a default rather than a configured extra. Overridable so a deployment that would
 * rather run its own tile server can point at it without touching this file.
 *
 * This is a *reference* source, not a basemap. The ground is ours — relief from the DEM we
 * already decode — and what comes from here is the part relief cannot say on its own: the
 * names of things. A shaded mountain with no word on it is a beautiful picture and a bad
 * map, because "where am I" is answered by a place name at least as often as by a contour.
 */
const DEFAULT_OMT_URL = 'https://tiles.openfreemap.org/planet';

export function openMapTilesUrl(): string {
  return process.env.NEXT_PUBLIC_OPENMAPTILES_URL?.trim() || DEFAULT_OMT_URL;
}

/**
 * Where glyphs come from when we are not hosting a PMTiles archive.
 *
 * `glyphs` is not decoration and it is not optional: MapLibre validates the style before it
 * draws anything, and a symbol layer with nowhere to fetch a fontstack from fails the whole
 * style — not just the labels. The raster bases carry no labels of their own, so it is easy
 * to assume the key is inert on them and leave it unset; it is not, because the *route* map
 * draws waypoint names, and the trail map is one component away from doing the same. A style
 * that renders on `/explore` and dies on a trail page is exactly the shape of bug that gets
 * shipped.
 *
 * Protomaps publishes these as the companion asset to the basemap we would self-host, so the
 * fontstack names are the same either way and switching a deployment onto its own archive
 * changes where the glyphs load from and nothing else. Open fonts, no key, no quota.
 */
const DEFAULT_GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

/**
 * The glyph endpoint for the current deployment: our own archive's, or the public one.
 *
 * Exported because the offline downloader has to pre-cache these too, and a downloader that
 * guessed the public URL while the map asked our archive for the same glyphs would cache
 * three files nobody ever requests and label the map as available offline.
 */
export function glyphsUrl(): string {
  const url = pmtilesUrl();
  return url ? `${url.replace(/\/[^/]*$/, '')}/fonts/{fontstack}/{range}.pbf` : DEFAULT_GLYPHS;
}

/**
 * Which of a feature's many names to draw.
 *
 * OpenMapTiles carries every `name:*` tag OSM has for a feature — some eighty languages on a
 * well-mapped summit — and `['get', 'name']` selects none of them. It selects the *local*
 * name: the place as written by the people who live there, in their own script. That is the
 * correct answer for a map of the place and the wrong one for a reader of this app, who gets
 * Мусала in the Rila, 富士山 in Honshu and جبل اللوز in the Hijaz, and can navigate by none
 * of them — cannot type them into the search box, cannot read them back to a companion,
 * cannot match them against the trail name printed a centimetre away in English.
 *
 * So: an explicit English name, then the tile schema's own `name_en`, then a Latin
 * transliteration, then OSM's international name, and only then the local one. The last step
 * carries as much weight as the first — a hamlet with no English name still has a name, and
 * blanking it because it could not be translated is worse than printing it in Cyrillic.
 *
 * Deliberately not `navigator.language`. Two people planning the same walk over a call would
 * otherwise be reading different summits off the same screen, and the app's own text is
 * English throughout; a map that localises while the page around it does not is a mismatch
 * the reader has to resolve. This is a product decision, not a locale one.
 *
 * Right-to-left names that survive to the last step need `setRTLTextPlugin` to be shaped and
 * ordered correctly — see `registerRTLText`. Without it Arabic renders letter-reversed and
 * unjoined, which is not a language a reader of Arabic can read either.
 */
export const LABEL_NAME: ExpressionSpecification = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name_en'],
  ['get', 'name:latin'],
  ['get', 'name_int'],
  ['get', 'name'],
];

/**
 * A summit label: the name, and beneath it the height.
 *
 * The height is the reason a hiker reads a peak label at all — it is the difference between a
 * hill they can add to the afternoon and a mountain they cannot — so it takes its own line
 * rather than a parenthesis, and it takes the reader's own units. A stat table reading
 * 9,415 ft above a map reading 2,869 m is two numbers for one mountain, and the reader has to
 * perform the conversion themselves before they can tell that the two agree.
 *
 * `ele_ft` ships in the tiles already, rounded by the tile build, so imperial is a lookup
 * rather than arithmetic in the common case. Where it is missing the metres are divided by
 * `METRES_PER_FOOT` — the same constant every stat table in the product converts with, which
 * is the point of reaching for it here rather than writing 3.28084 into a style expression.
 *
 * `ele` is absent on a great many OSM peaks, and `concat` with a null renders the literal
 * word "null" onto the map, so the heightless case is built as its own branch rather than
 * patched afterwards.
 */
export function peakTextField(units: UnitSystem): ExpressionSpecification {
  const height: ExpressionSpecification =
    units === 'imperial'
      ? [
          'concat',
          [
            'to-string',
            ['round', ['coalesce', ['get', 'ele_ft'], ['/', ['get', 'ele'], METRES_PER_FOOT]]],
          ],
          ' ft',
        ]
      : ['concat', ['to-string', ['round', ['get', 'ele']]], ' m'];

  return ['case', ['has', 'ele'], ['concat', LABEL_NAME, '\n', height], LABEL_NAME];
}

/**
 * The bases actually offered right now.
 *
 * All three, always, now that topo has an unconfigured source to fall back to. It used to
 * drop out when `NEXT_PUBLIC_PMTILES_URL` was unset, which was right when the alternative
 * was a switcher entry that opened a blank screen.
 */
export function availableBasemaps(): readonly BasemapMeta[] {
  return BASEMAPS;
}

const DEM_SOURCE = 'terrain-dem';
const IMAGERY_SOURCE = 'esri-imagery';
const VECTOR_SOURCE = 'protomaps';
const OMT_SOURCE = 'openmaptiles';

/**
 * Elevations, in metres, at which each band in `ELEVATION_BANDS` is at full strength.
 *
 * Graduated rather than evenly spaced, because trails are not evenly spaced. Half the
 * world's hiking happens below 600 m, so the ramp spends half its resolution there: in
 * Snowdonia a 1,085 m summit still crosses four bands, and in the Alps a 4,000 m face has
 * not run out of ramp. One global ramp rather than a per-viewport stretch is deliberate —
 * a colour that means 900 m has to keep meaning 900 m when you pan.
 *
 * Exported because the printed sheet builds its own light ramp from the same bands. A second
 * copy of these numbers would let the screen and the paper disagree about what 1,100 m looks
 * like, which is the one thing `ELEVATION_BANDS` exists to prevent.
 */
export const BAND_ELEVATIONS_M = [0, 250, 600, 1100, 1800, 2700, 3800] as const;

/** Sea and inland water, below the first band. Terrarium encodes ocean at or below zero. */
const WATER_TINT = '#16323D';

/**
 * Lakes and rivers drawn from vector data, as opposed to inferred from the DEM.
 *
 * Lighter than `WATER_TINT`, which is tuned for ocean seen at continental zoom where near
 * black is right. A tarn below a summit is read at 1:25k against shaded ground, and at that
 * scale the same colour stops looking like water and starts looking like a hole in the map.
 */
const WATER_BODY = '#1E4E63';

/**
 * The ground the hypsometric tint sits on once the tint eases back.
 *
 * Between valley woodland and upland pasture — the two bands most hiking happens in, so
 * the colour a large-scale view settles to is the one it was already mostly showing.
 *
 * Exported because a key that paints its swatches on the panel is not showing the reader
 * what the map will look like. A translucent overlay's swatch has to sit on the ground the
 * overlay actually covers, or the key's darkest band and its lightest can look the same.
 */
export const GROUND_TINT = '#4F6B3B';

/**
 * The dark edge every drawn line and mark is set against.
 *
 * Not a scheme colour, and deliberately not `ink`. Ink is the text plate and follows the
 * light/dark mode; a casing has one job — separate a green line from green ground — and it
 * has to do that job identically on relief, on satellite imagery, and on paper, none of
 * which change when the reader switches to dark mode. Fixed here, once.
 *
 * It was previously typed out seven times across `trail-layers` and `track-layers`, in a
 * file that already imports `SCHEMES` — which is exactly how six of them stay one value
 * while the seventh quietly becomes another.
 */
export const CASING = '#0B1214';

/**
 * `[elev, colour, elev, colour, …]` for `color-relief-color`.
 *
 * The two stops below zero are what give a coastline an edge: without them the ramp
 * interpolates the sea toward valley green and the shoreline dissolves.
 */
function hypsometricRamp(): (number | string)[] {
  const stops: (number | string)[] = [-2000, WATER_TINT, -1, WATER_TINT];
  ELEVATION_BANDS.forEach((color, index) => {
    stops.push(BAND_ELEVATIONS_M[index] ?? 4200, color);
  });
  return stops;
}

/**
 * MapLibre reads a raster-DEM source itself, so the tiles are requested by the map rather
 * than through `@switchback/geo`. The URL template is shared with the ingest pipeline for
 * one reason worth stating: the hillshade the user reads and the gain figure we publish are
 * then derived from the same pixels, and cannot disagree.
 *
 * Exported for the printed sheet, which builds a light style of its own. Same guarantee,
 * extended to paper: the relief someone folds into a jacket pocket is shaded off the same
 * elevations as the ascent figure printed beside it.
 */
export function demSource() {
  return {
    type: 'raster-dem' as const,
    tiles: [TERRARIUM_URL_TEMPLATE],
    encoding: 'terrarium' as const,
    tileSize: 256,
    maxzoom: 15,
    attribution: `<a href="${ATTRIBUTION.terrain.href}">${ATTRIBUTION.terrain.label}</a>`,
  };
}

/**
 * Ease the shading off as the scale grows past what the DEM can actually support.
 *
 * Terrarium's global coverage is SRTM-derived, so a sample is about 90 m apart at these
 * latitudes however deep the tile pyramid goes. Around z13 a screen pixel passes that
 * spacing, and from there the hillshade is no longer shading terrain — it is drawing the
 * seams between DEM samples, as a field of lit and unlit facets that look like coarse
 * gravel laid over the mountain.
 *
 * Holding the exaggeration flat and letting it break is the wrong trade, and so is
 * dropping the layer at a hard zoom — the relief would pop out mid-pinch. Interpolating it
 * down instead means the ridges stay dramatic at the zooms where relief is what you are
 * reading, and the ground settles into its hypsometric colour at the zooms where you are
 * reading the trail line on top of it. It is the same decision a printed series makes:
 * relief shading belongs on the small-scale sheet, contours on the large-scale one.
 *
 * **In three dimensions it eases much less far**, because the premise changes. The zoom
 * fixes the scale at the point the camera is looking at, and under a pitched camera almost
 * none of the frame is at that point — the ground runs away to a horizon several kilometres
 * off, where a screen pixel still covers a great deal more than 90 m. The over-sampling this
 * guards against is confined to a strip along the bottom edge. Easing to a fifteenth over the
 * whole frame to protect that strip is what turned a flyover over 2,000 m of Rockies into a
 * uniform green blanket.
 */
function exaggerationByZoom(base: number, terrain: boolean): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    11,
    base,
    terrain ? 15 : 14,
    // Not zero. A trace of shading still separates a valley floor from the slope above it,
    // which is the one thing the flat tint cannot say on its own.
    Number((base * (terrain ? 0.45 : 0.15)).toFixed(3)),
  ];
}

/**
 * How much the ground is lifted when the map is rendered in three dimensions.
 *
 * Slightly above life size, and the reason is a correction rather than a flourish. Terrarium
 * is SRTM-derived, so a sample is about 90 m apart; every summit in it is the average of the
 * ninety metres around it and comes out tens of metres short, while the valleys come out
 * shallow by the same mechanism. Rendered at 1.0 the DEM does not look honest, it looks
 * *smoothed* — a range of rounded hills where there are aretes. A fifth over restores roughly
 * what the sampling took out.
 *
 * It stops well short of the 1.5–2.0 that mapping products normally reach for, because past
 * that the reader is being sold a mountain rather than shown one, and this product prints the
 * real gain figure two hundred pixels below the map.
 */
export const TERRAIN_EXAGGERATION = 1.2;

/**
 * The tilt the map settles at when the reader turns the ground on.
 *
 * A checkbox that appears to do nothing is a checkbox nobody ticks twice. Enabling the mesh
 * without moving the camera is exactly that: from directly overhead a height field and a
 * hillshade of the same height field are the same picture, so the only evidence anything
 * happened would be that a gesture the reader has not tried yet now works.
 *
 * Fifty degrees rather than the flyover's sixty-six. This is a tilt to read a map at, not a
 * shot to watch — the horizon stays out of frame, so the far half of the route is still a
 * route rather than a line compressed into three pixels of perspective, and the reader can
 * still see where they are on the ground rather than where the camera is.
 */
export const TERRAIN_PITCH = 50;

/**
 * What sits above the horizon once the sheet is tilted.
 *
 * A quadrangle has no sky — it is a drawing made from directly overhead, and the question
 * never comes up. Tilt it and the question is unavoidable: something occupies the top third
 * of the frame, and left undeclared that something is the page's own near-black, meeting the
 * ground along a hard line that reads as the map having run out rather than as a horizon.
 *
 * The answer is not a blue sky. Blue would be a photograph of a place, and every other mark
 * on this map is a drawing of one. So the sky is the sheet's own darkness, graduating to
 * `bezel` at the horizon — the tone this product draws every edge in, used here for the
 * largest edge there is.
 *
 * The fog is the part doing structural work. During a flyover the DEM arrives a tile at a
 * time and the far edge of what has loaded is a cliff standing over nothing; in the horizon's
 * own colour that seam lands where the reader already expects the ground to stop, so terrain
 * streaming in at 60 km/h reads as distance rather than as damage. MapLibre only draws it
 * between about 60° and 70° of pitch, which is the band `FLYOVER_PITCH` sits in and the band
 * where the horizon is actually in frame.
 *
 * `atmosphere-blend` is zeroed because the default fades one in below zoom 12 for the globe
 * projection, and on a Mercator sheet that is a blue halo around a mountain range.
 */
function sky(field: (typeof SCHEMES)['field']): SkySpecification {
  return {
    'sky-color': field.canvas,
    'sky-horizon-blend': 0.6,
    'horizon-color': field.bezel,
    'horizon-fog-blend': 0.6,
    'fog-color': field.bezel,
    // High, so haze is confined to the last of the distance. Lower and it washes the middle
    // ground, which is where the route the reader came to look at usually is.
    'fog-ground-blend': 0.85,
    'atmosphere-blend': 0,
  };
}

/**
 * Build the style for one base.
 *
 * Rebuilt on switch rather than toggling layer visibility, because the sources differ per
 * base and carrying all of them means a satellite viewer still downloading vector tiles.
 * Trail layers are added by the map component afterwards — they are the same on every base.
 *
 * `slope` is optional because most maps in the product have no business offering it: the
 * recorder and the Lifeline sheet already spend the survey plate on the reader's own
 * position, and a second red on those screens would be the worst possible ambiguity.
 *
 * `terrain` is optional for a different reason: it costs a second DEM decode per tile and a
 * depth pass per frame, so a map that is never pitched should not pay for it. It is set on
 * the style rather than applied afterwards with `setTerrain` so that a base-map switch cannot
 * drop it — the style is rebuilt on every switch, and anything applied imperatively outside
 * it has to be reapplied by hand on the far side of a `styledata` event.
 *
 * `units` is required, and that is the whole design of it. It reads as a nuisance at eleven
 * call sites — every one of them a map that could have defaulted quietly to metric — but a
 * default here is precisely how the peak labels came to read metres under an imperial stat
 * table and stayed that way through two audits. A required field makes the compiler ask the
 * question at each new map, once, at the moment somebody is in a position to answer it.
 */
export function buildStyle(
  basemap: BasemapId,
  options: { hillshade: boolean; units: UnitSystem; slope?: boolean; terrain?: boolean },
): StyleSpecification {
  const field = SCHEMES.field;
  // Read once: the mesh changes what several layers below are *for*, not just whether they
  // are drawn, so it is worth having under one name rather than reached through `options`.
  const terrain = options.terrain === true;
  const style: StyleSpecification = {
    version: 8,
    // Symbol layers resolve their fontstack against this. Always a string, never absent —
    // see `glyphsUrl`. A missing or `undefined` value fails style validation outright.
    glyphs: glyphsUrl(),
    sources: {},
    layers: [
      // Under everything: the canvas shows through wherever a tile has not arrived, so a
      // loading map is the page's own colour rather than a white flash.
      { id: 'canvas', type: 'background', paint: { 'background-color': field.canvas } },
    ],
  };

  if (basemap === 'relief') {
    style.sources[DEM_SOURCE] = demSource();
    // A plain ground tone for the tint to settle onto. Without it, easing the tint back at
    // large scale would expose the page's near-black canvas and the mountain would go out
    // like a light; with it, the ground simply stops being graduated.
    style.layers.push({
      id: 'ground',
      type: 'background',
      paint: { 'background-color': GROUND_TINT },
    });
    style.layers.push({
      id: 'hypsometric',
      type: 'color-relief',
      source: DEM_SOURCE,
      paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation'], ...hypsometricRamp()],
        /*
         * Held below full so the hillshade above reads as shading rather than as a second
         * colour. At 1.0 the tint wins and the ground goes flat.
         *
         * And eased back past z13 for the same reason the shading is — `color-relief`
         * samples the DEM per screen pixel with no smoothing, so once a pixel is finer than
         * the DEM's ~90 m spacing the tint stops describing height and starts drawing the
         * sample grid as a chequerboard. Height is a small-scale question on a flat sheet
         * anyway: at 1:25k you are reading the path, not deciding which massif to hike up.
         *
         * Under a mesh it is the opposite question, so it barely eases at all. In three
         * dimensions the shape is carried by the ground itself, which frees the tint to do the
         * one thing the shape cannot: say which of two identically-lit slopes is a 1,500 m
         * forest and which is 3,100 m of rock and snow. Take that away and a flyover over the
         * Rockies is the same olive green from the trailhead to the summit.
         */
        'color-relief-opacity': terrain
          ? ['interpolate', ['linear'], ['zoom'], 11, 0.82, 15, 0.62]
          : ['interpolate', ['linear'], ['zoom'], 11, 0.82, 14, 0.15],
      },
    });
  }

  if (basemap === 'satellite') {
    style.sources[IMAGERY_SOURCE] = {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: `<a href="${ATTRIBUTION.esriImagery.href}">${ATTRIBUTION.esriImagery.label}</a>`,
    };
    style.layers.push({ id: 'imagery', type: 'raster', source: IMAGERY_SOURCE });
  }

  if (basemap === 'topo') {
    const url = pmtilesUrl();
    if (url) {
      style.sources[VECTOR_SOURCE] = {
        type: 'vector',
        url: `pmtiles://${url}`,
        attribution: `<a href="${ATTRIBUTION.protomaps.href}">${ATTRIBUTION.protomaps.label}</a>`,
      };
      style.layers.push(...protomapsLayers());
    } else {
      // No archive of our own, so topo is the reference source drawing its own ground too:
      // land under water under everything the overlay adds below. Still keyless.
      style.layers.push({
        id: 'topo-ground',
        type: 'background',
        paint: { 'background-color': field.canvas },
      });
    }
  }

  // Hillshade sits above whichever base was chosen. Over imagery it is what turns a flat
  // green plane into a face you can read the angle of; over the hypsometric tint it is
  // half the picture. The DEM source is added here when the base did not already need it.
  if (options.hillshade) {
    style.sources[DEM_SOURCE] ??= demSource();
    style.layers.push({
      id: 'hillshade',
      type: 'hillshade',
      source: DEM_SOURCE,
      paint: {
        // Northwest light, the cartographic convention — relief read under light from any
        // other quarter inverts, and ridges are perceived as gullies.
        'hillshade-illumination-direction': 315,
        'hillshade-exaggeration': exaggerationByZoom(
          basemap === 'satellite' ? 0.35 : 0.55,
          terrain,
        ),
        'hillshade-shadow-color': '#0B1214',
        'hillshade-highlight-color': '#FFF6E4',
        'hillshade-accent-color': '#0B1214',
      },
    });
  }

  /*
   * The ground itself, in three dimensions.
   *
   * Same DEM as the hillshade and the slope layer, and that is worth being deliberate about:
   * a terrain mesh built from one elevation model with shading painted from another produces
   * shadows that fall on the wrong side of a ridge, and the reader has no way to know which
   * of the two is lying. One source, three readings of it.
   *
   * `terrain` on the style rather than `setTerrain` on the map — see the note on this
   * function. It also means the first paint is already pitched-capable, so a flyover that
   * starts immediately after a base switch does not sweep across flat ground for a second
   * while the mesh loads.
   */
  if (terrain) {
    style.sources[DEM_SOURCE] ??= demSource();
    style.terrain = { source: DEM_SOURCE, exaggeration: TERRAIN_EXAGGERATION };
    style.sky = sky(field);
  }

  /*
   * Slope angle above the shading and below the names.
   *
   * Above, because it is a measurement and the hillshade is a picture — a wash of red under
   * a cast shadow is a wash of red you cannot judge the strength of, and the strength is the
   * reading. Below the reference layers, because the overlay's job is to describe ground,
   * not to bury the path and the place names a reader is using it to choose between.
   *
   * Tiles are computed in the browser by `registerSlopeProtocol`, from the same DEM as the
   * hillshade, so the two never disagree about where a face is. The attribution is the DEM's
   * for that reason — nothing else went into it.
   */
  if (options.slope) {
    style.sources[SLOPE_SOURCE] = {
      type: 'raster',
      tiles: [SLOPE_TILE_URL],
      tileSize: 256,
      // Both ends the same number, deliberately: see `SLOPE_TILE_ZOOM`. Pinning the source
      // to a single zoom is what fixes the measurement baseline, and MapLibre's ordinary
      // over- and under-zoom does the rest. Splitting these two apart would silently put the
      // layer back to reading a different angle at every scale.
      minzoom: SLOPE_TILE_ZOOM,
      maxzoom: SLOPE_TILE_ZOOM,
      attribution: `<a href="${ATTRIBUTION.terrain.href}">${ATTRIBUTION.terrain.label}</a>`,
    };
    style.layers.push({
      id: SLOPE_LAYER,
      type: 'raster',
      source: SLOPE_SOURCE,
      paint: {
        'raster-opacity': 1,
        // The bands are already the answer; smoothing them would invent angles between two
        // adjacent readings and blur the 35° edge that the whole layer exists to show. It is
        // also what keeps the overzoomed blocks honest about the resolution behind them.
        'raster-resampling': 'nearest',
        // No cross-fade either. A tile easing in over 300 ms reads as the slope changing.
        'raster-fade-duration': 0,
      },
    });
  }

  /*
   * Names on top, and on top of the shading rather than under it — a label lying in a cast
   * shadow is a label you cannot read at exactly the moment the terrain is most dramatic.
   *
   * Skipped only when a PMTiles archive is serving topo, which brings its own labels in its
   * own schema; mixing the two would double every place name.
   */
  if (!(basemap === 'topo' && pmtilesUrl())) {
    style.sources[OMT_SOURCE] = {
      type: 'vector',
      url: openMapTilesUrl(),
      attribution: `<a href="${ATTRIBUTION.openFreeMap.href}">${ATTRIBUTION.openFreeMap.label}</a>`,
    };
    style.layers.push(...referenceLayers({ fills: basemap !== 'satellite', units: options.units }));
  }

  return style;
}

/**
 * A minimal Protomaps basemap: ground, water, roads, paths, labels.
 *
 * Deliberately not the full Protomaps style. Everything a road map cares about — building
 * footprints, retail POIs, motorway shields — is noise under a trail line, and each one is
 * a layer whose colours would then have to be kept in step with the palette. What is here
 * is what a hiker reads: water, the path network, and enough naming to know where you are.
 */
function protomapsLayers(): StyleSpecification['layers'] {
  const field = SCHEMES.field;
  return [
    {
      id: 'earth',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'earth',
      paint: { 'fill-color': field.canvas },
    },
    {
      id: 'landuse-wood',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['forest', 'wood', 'nature_reserve', 'park']]],
      paint: { 'fill-color': field.woodlandWash },
    },
    {
      id: 'water',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'water',
      paint: { 'fill-color': WATER_TINT },
    },
    {
      id: 'roads',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'roads',
      paint: {
        'line-color': field.bezel,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 14, 1.6, 18, 6],
      },
    },
    {
      id: 'paths',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'roads',
      filter: ['==', ['get', 'kind'], 'path'],
      paint: {
        'line-color': field.inkMuted,
        'line-dasharray': [2, 2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 18, 2],
      },
    },
    {
      id: 'place-labels',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'places',
      layout: {
        'text-field': LABEL_NAME,
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 14, 13],
        'text-letter-spacing': 0.06,
      },
      paint: {
        'text-color': field.ink,
        'text-halo-color': field.canvas,
        'text-halo-width': 1.2,
      },
    },
  ];
}

/**
 * The names, drawn over whatever ground was chosen.
 *
 * Relief and satellite are both wordless by construction — one is a DEM, the other is a
 * photograph — and for a long time that meant every map in this product was a beautiful
 * surface you could not navigate by. This is the layer that fixes it, and it is deliberately
 * a *reference* set rather than a basemap: hydrography, the road and path network, and
 * labels. No buildings, no shop POIs, no road shields. The ground is still ours.
 *
 * The plate assignments are the design system's, applied to cartography for the first time
 * and they land unusually cleanly:
 *
 * - **Peaks are `contour`.** A summit label is an elevation fact, and elevation is the
 *   contour plate. It also means a named peak and the point on the elevation profile that
 *   corresponds to it are literally the same colour, on two different graphics.
 * - **Water is `water`.** The plate is nominally conditions and weather, and a lake is the
 *   most literal reading of it available.
 * - **Roads and paths are structural**, so `bezel` and `inkMuted` — quiet by construction,
 *   because the one line on this map that must never be mistaken for another is the trail,
 *   and the trail is woodland and drawn on top of all of this.
 *
 * `fills` is off over satellite. Imagery already shows a lake better than a flat polygon
 * can, so there the only thing missing was its name.
 */
function referenceLayers(options: {
  fills: boolean;
  units: UnitSystem;
}): StyleSpecification['layers'] {
  const field = SCHEMES.field;
  const layers: StyleSpecification['layers'] = [];

  if (options.fills) {
    layers.push({
      id: 'omt-water',
      type: 'fill',
      source: OMT_SOURCE,
      'source-layer': 'water',
      // Intermittent water is a dry bed for most of the year, and drawing it as a lake has
      // sent people looking for water that is not there.
      filter: ['!=', ['get', 'intermittent'], 1],
      paint: { 'fill-color': WATER_BODY },
    });
    layers.push({
      id: 'omt-waterway',
      type: 'line',
      source: OMT_SOURCE,
      'source-layer': 'waterway',
      minzoom: 9,
      paint: {
        /*
         * The bright end of the water plate, not the lake's own colour. A stream is one or
         * two pixels wide, and a fill colour chosen to read as depth reads as a black
         * scratch at that width — indistinguishable from a cliff edge on shaded ground.
         * Lakes are bodies and go dark; watercourses are lines and have to stay legible.
         */
        'line-color': field.water,
        'line-opacity': 0.75,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.8, 18, 4],
      },
    });
  }

  layers.push({
    id: 'omt-roads',
    type: 'line',
    source: OMT_SOURCE,
    'source-layer': 'transportation',
    minzoom: 7,
    filter: [
      'in',
      ['get', 'class'],
      ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']],
    ],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': field.bezel,
      'line-opacity': 0.85,
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 12, 1.2, 16, 4],
    },
  });

  layers.push({
    id: 'omt-paths',
    type: 'line',
    source: OMT_SOURCE,
    'source-layer': 'transportation',
    minzoom: 12,
    filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]],
    paint: {
      'line-color': field.inkMuted,
      'line-dasharray': [2, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 18, 2],
    },
  });

  layers.push({
    id: 'omt-place-labels',
    type: 'symbol',
    source: OMT_SOURCE,
    'source-layer': 'place',
    filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'hamlet']]],
    layout: {
      'text-field': LABEL_NAME,
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 14, 13],
      'text-letter-spacing': 0.06,
      // Lower rank is a bigger place. Where two labels collide, the city survives.
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
    },
    paint: {
      'text-color': field.ink,
      'text-halo-color': field.canvas,
      'text-halo-width': 1.4,
    },
  });

  layers.push({
    id: 'omt-water-labels',
    type: 'symbol',
    source: OMT_SOURCE,
    'source-layer': 'water_name',
    minzoom: 9,
    layout: {
      'text-field': LABEL_NAME,
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 14, 12],
      'text-letter-spacing': 0.12,
      'text-max-width': 8,
    },
    paint: {
      'text-color': field.water,
      'text-halo-color': field.canvas,
      'text-halo-width': 1.2,
    },
  });

  // Peaks last, so they win every label collision on the map. On a hiking product the named
  // summit is the destination; a village three valleys away is not allowed to displace it.
  layers.push(...peakLayers('major', options.units), ...peakLayers('minor', options.units));

  return layers;
}

/**
 * Named summits, in two tiers.
 *
 * Drawn as two pairs of layers rather than one, because the alternative does not exist:
 * MapLibre only accepts `["zoom"]` as the direct input of a top-level `step` or
 * `interpolate`, so a filter of the form "rank at most *n*, where *n* depends on zoom"
 * cannot be written. Splitting on rank and letting `minzoom` do the zoom half says the same
 * thing and cannot throw.
 *
 * It also has to be done at all. OpenStreetMap names a great many peaks, and drawn without
 * a rank filter a Welsh or Cascade viewport at z12 is a solid field of orange text with the
 * trail somewhere underneath it — every knoll shouting as loudly as the mountain. This is
 * the oldest rule in small-scale cartography: at 1:100k you name the range, and you wait
 * until 1:25k to name what is in it.
 */
function peakLayers(tier: 'major' | 'minor', units: UnitSystem): StyleSpecification['layers'] {
  const field = SCHEMES.field;
  const major = tier === 'major';

  // `rank` is 1 for the most prominent peak in a tile and climbs from there. Absent on a
  // handful of nodes, which are treated as minor rather than dropped.
  const filter: ExpressionSpecification = [
    'all',
    ['==', ['geometry-type'], 'Point'],
    major
      ? ['<=', ['coalesce', ['get', 'rank'], 99], 1]
      : ['>', ['coalesce', ['get', 'rank'], 99], 1],
  ];
  const minzoom = major ? 9 : 13;

  return [
    {
      id: `omt-peak-marks-${tier}`,
      type: 'circle',
      source: OMT_SOURCE,
      'source-layer': 'mountain_peak',
      minzoom,
      filter,
      paint: {
        'circle-radius': major ? 3 : 2,
        'circle-color': field.contour,
        'circle-stroke-width': 1,
        'circle-stroke-color': field.canvas,
      },
    },
    {
      id: `omt-peak-labels-${tier}`,
      type: 'symbol',
      source: OMT_SOURCE,
      'source-layer': 'mountain_peak',
      minzoom,
      filter,
      layout: {
        'text-field': peakTextField(units),
        'text-font': ['Noto Sans Regular'],
        'text-size': major
          ? ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 12.5]
          : ['interpolate', ['linear'], ['zoom'], 13, 9.5, 16, 11],
        'text-letter-spacing': 0.04,
        'text-offset': [0, 0.8],
        'text-anchor': 'top',
        'text-max-width': 9,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
      },
      paint: {
        'text-color': field.contour,
        // The lesser summits step back rather than disappear, so a viewport that has just
        // crossed z13 gains detail instead of gaining a second layer of shouting.
        'text-opacity': major ? 1 : 0.75,
        'text-halo-color': field.canvas,
        'text-halo-width': 1.4,
      },
    },
  ];
}
