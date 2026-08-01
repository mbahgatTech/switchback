import type { ExpressionSpecification, SkySpecification, StyleSpecification } from 'maplibre-gl';
import { ATTRIBUTION, METRES_PER_FOOT, type UnitSystem } from '@switchback/core';
import { ELEVATION_BANDS, SCHEMES } from '@switchback/ui';
import { TERRARIUM_URL_TEMPLATE } from '@switchback/geo';
import { SLOPE_LAYER, SLOPE_SOURCE, SLOPE_TILE_URL, SLOPE_TILE_ZOOM } from './slope';

/**
 * MapLibre styles for the three bases: relief rendered from the terrarium DEM, Esri imagery,
 * and a keyless vector topo sheet. Every base carries the same reference overlay on top.
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
 * Hosts that mean "not configured". A fresh clone copies `.env.example` verbatim, so the
 * common failure is a URL that is set but points at a host that does not resolve.
 */
const PLACEHOLDER_HOSTS = ['cdn.example.com', 'example.com'];

/** The deployment's own PMTiles archive, or null when none is configured. */
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

/** OpenFreeMap's planet-wide OpenMapTiles build — keyless and unmetered, so it can be a default. */
const DEFAULT_OMT_URL = 'https://tiles.openfreemap.org/planet';

/** Vector tiles for the reference overlay (names, water, paths), not for the ground. */
export function openMapTilesUrl(): string {
  return process.env.NEXT_PUBLIC_OPENMAPTILES_URL?.trim() || DEFAULT_OMT_URL;
}

/**
 * MapLibre validates `glyphs` before drawing anything, and a symbol layer with nowhere to
 * fetch a fontstack from fails the whole style — not just its labels. Never leave it unset.
 */
const DEFAULT_GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

/**
 * The glyph endpoint for this deployment: our own archive's, or the public one. Exported so
 * the offline downloader pre-caches the same URLs the map will actually request.
 */
export function glyphsUrl(): string {
  const url = pmtilesUrl();
  return url ? `${url.replace(/\/[^/]*$/, '')}/fonts/{fontstack}/{range}.pbf` : DEFAULT_GLYPHS;
}

/**
 * Which of a feature's `name:*` tags to draw. Deliberately English-first rather than
 * `navigator.language` or bare `name` (the local script), because the UI around the map is
 * English; RTL names reaching the last fallback need `registerRTLText` to shape correctly.
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
 * A summit label: the name, and beneath it the height in the reader's units.
 *
 * The heightless case is a separate branch because `concat` with a null `ele` renders the
 * literal word "null" onto the map, and a great many OSM peaks carry no elevation.
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

/** All three bases, always: topo now falls back to a keyless source when PMTiles is unset. */
export function availableBasemaps(): readonly BasemapMeta[] {
  return BASEMAPS;
}

const DEM_SOURCE = 'terrain-dem';
const IMAGERY_SOURCE = 'esri-imagery';
const VECTOR_SOURCE = 'protomaps';
const OMT_SOURCE = 'openmaptiles';

/**
 * Elevations, in metres, at which each `ELEVATION_BANDS` colour is at full strength.
 *
 * Graduated rather than evenly spaced, so most of the ramp's resolution sits below 1,100 m
 * where most hiking happens. Exported so the printed sheet builds its light ramp from the
 * same numbers; a second copy would let screen and paper disagree about what 1,100 m looks like.
 */
export const BAND_ELEVATIONS_M = [0, 250, 600, 1100, 1800, 2700, 3800] as const;

/** Sea and inland water, below the first band. Terrarium encodes ocean at or below zero. */
const WATER_TINT = '#16323D';

/**
 * Lakes and rivers drawn from vector data. Lighter than `WATER_TINT`, which is tuned for
 * ocean at continental zoom and reads as a hole in the map at 1:25k.
 */
const WATER_BODY = '#1E4E63';

/**
 * The ground the hypsometric tint eases back onto. Exported because a key's swatches must be
 * painted over the same ground the translucent overlay covers, or the bands look alike.
 */
export const GROUND_TINT = '#4F6B3B';

/**
 * The dark edge every drawn line and mark is set against.
 *
 * Fixed rather than taken from `SCHEMES`: a casing has to separate a green line from green
 * ground identically on relief, on imagery and on paper, none of which follow dark mode.
 */
export const CASING = '#0B1214';

/**
 * `[elev, colour, elev, colour, …]` for `color-relief-color`. The two stops below zero are
 * what give a coastline an edge — without them the ramp dissolves the shoreline into valley green.
 */
function hypsometricRamp(): (number | string)[] {
  const stops: (number | string)[] = [-2000, WATER_TINT, -1, WATER_TINT];
  ELEVATION_BANDS.forEach((color, index) => {
    stops.push(BAND_ELEVATIONS_M[index] ?? 4200, color);
  });
  return stops;
}

/**
 * The raster-DEM source MapLibre fetches itself. Shares `TERRARIUM_URL_TEMPLATE` with the
 * ingest pipeline so the hillshade and the published gain figure derive from the same pixels.
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
 * Ease the shading off past the scale the DEM supports. Terrarium samples are ~90 m apart at
 * any zoom, so beyond about z13 the hillshade draws the sample grid rather than the terrain.
 * Under a pitched camera most of the frame is far from the zoom's reference point, so a mesh
 * eases far less — easing the whole frame to protect the bottom strip flattens a flyover.
 */
function exaggerationByZoom(base: number, terrain: boolean): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    11,
    base,
    terrain ? 15 : 14,
    // Not zero. A trace of shading still separates a valley floor from the slope above it.
    Number((base * (terrain ? 0.45 : 0.15)).toFixed(3)),
  ];
}

/**
 * Vertical exaggeration for the 3D mesh. Slightly over life size to offset SRTM's ~90 m
 * sampling, which shaves summits and fills valleys; short of the 1.5–2.0 other products use.
 */
export const TERRAIN_EXAGGERATION = 1.2;

/**
 * The tilt the map settles at when the reader turns the ground on — from directly overhead a
 * mesh and a hillshade of it are the same picture, so the toggle has to move the camera.
 */
export const TERRAIN_PITCH = 50;

/**
 * What sits above the horizon once the sheet is tilted: the sheet's own darkness graduating
 * to `bezel`, never a photographic blue.
 *
 * The fog does structural work — it hides the cliff edge where streamed DEM tiles run out.
 * MapLibre only draws it between roughly 60° and 70° of pitch, the band `FLYOVER_PITCH` sits
 * in. `atmosphere-blend` is zeroed because its default paints a blue halo below z12 on Mercator.
 */
function sky(field: (typeof SCHEMES)['field']): SkySpecification {
  return {
    'sky-color': field.canvas,
    'sky-horizon-blend': 0.6,
    'horizon-color': field.bezel,
    'horizon-fog-blend': 0.6,
    'fog-color': field.bezel,
    // High, so haze is confined to the last of the distance, not the middle ground where the
    // route usually is.
    'fog-ground-blend': 0.85,
    'atmosphere-blend': 0,
  };
}

/**
 * Build the style for one base. Rebuilt on switch rather than toggling visibility, so a
 * satellite viewer is not still downloading vector tiles. Trail layers are added afterwards.
 *
 * `terrain` is set on the style rather than via `setTerrain` so a base switch cannot drop it.
 * `units` is required deliberately: a default here is how peak labels came to read metres
 * under an imperial stat table.
 */
export function buildStyle(
  basemap: BasemapId,
  options: { hillshade: boolean; units: UnitSystem; slope?: boolean; terrain?: boolean },
): StyleSpecification {
  const field = SCHEMES.field;
  const terrain = options.terrain === true;
  const style: StyleSpecification = {
    version: 8,
    // Always a string, never absent — a missing value fails style validation outright.
    glyphs: glyphsUrl(),
    sources: {},
    layers: [
      // Under everything, so a loading map is the page's own colour rather than a white flash.
      { id: 'canvas', type: 'background', paint: { 'background-color': field.canvas } },
    ],
  };

  if (basemap === 'relief') {
    style.sources[DEM_SOURCE] = demSource();
    // A plain ground tone for the tint to settle onto once it eases back at large scale;
    // without it the page's near-black canvas shows through.
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
         * Held below full so the hillshade above reads as shading rather than a second colour,
         * and eased back past z13 for the same reason the shading is: `color-relief` samples
         * per screen pixel with no smoothing, so a pixel finer than the DEM's ~90 m spacing
         * draws the sample grid. Under a mesh it barely eases — the shape is carried by the
         * ground, which frees the tint to say which of two lit slopes is forest and which is rock.
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
      // No archive of our own, so topo draws its own ground and the reference overlay below
      // supplies water, paths and names. Still keyless.
      style.layers.push({
        id: 'topo-ground',
        type: 'background',
        paint: { 'background-color': field.canvas },
      });
    }
  }

  // Hillshade sits above whichever base was chosen; the DEM source is added here when the
  // base did not already need it.
  if (options.hillshade) {
    style.sources[DEM_SOURCE] ??= demSource();
    style.layers.push({
      id: 'hillshade',
      type: 'hillshade',
      source: DEM_SOURCE,
      paint: {
        // Northwest light, the cartographic convention — under light from any other quarter
        // relief inverts and ridges are perceived as gullies.
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

  // The mesh reads the same DEM as the hillshade and the slope layer: mixing elevation models
  // would drop shadows on the wrong side of a ridge.
  if (terrain) {
    style.sources[DEM_SOURCE] ??= demSource();
    style.terrain = { source: DEM_SOURCE, exaggeration: TERRAIN_EXAGGERATION };
    style.sky = sky(field);
  }

  // Slope sits above the shading — a wash of red under a cast shadow cannot be judged — and
  // below the reference layers, so it does not bury paths and names. Tiles are computed in
  // the browser by `registerSlopeProtocol` from the same DEM, hence the DEM's attribution.
  if (options.slope) {
    style.sources[SLOPE_SOURCE] = {
      type: 'raster',
      tiles: [SLOPE_TILE_URL],
      tileSize: 256,
      // Both ends the same number, deliberately: see `SLOPE_TILE_ZOOM`. Pinning the source to
      // one zoom fixes the measurement baseline; splitting them reads a different angle per scale.
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
        // Nearest, not smoothed: interpolation would invent angles between two readings and
        // blur the 35° edge the layer exists to show.
        'raster-resampling': 'nearest',
        // No cross-fade either. A tile easing in over 300 ms reads as the slope changing.
        'raster-fade-duration': 0,
      },
    });
  }

  // Names on top of the shading rather than under it — a label in a cast shadow is unreadable
  // exactly when the terrain is most dramatic. Skipped when a PMTiles archive is serving topo,
  // which brings its own labels and would double every place name.
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
 * A minimal Protomaps basemap: ground, water, roads, paths, labels. Deliberately not the full
 * style — building footprints and retail POIs are noise under a trail line, and each extra
 * layer is another set of colours to keep in step with the palette.
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
 * Hydrography, roads, paths and labels drawn over whichever ground was chosen — relief and
 * satellite are both wordless by construction. A reference set, not a basemap: no buildings,
 * POIs or road shields. Plates follow the design system: peaks `contour`, water `water`,
 * roads and paths structural, so nothing competes with the trail line drawn on top.
 *
 * `fills` is off over satellite, where imagery already shows a lake better than a polygon can.
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
        // The bright end of the water plate, not the lake fill: at one or two pixels wide the
        // darker colour reads as a black scratch, indistinguishable from a cliff edge.
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

  // Peaks last, so they win every label collision: on a hiking product the named summit is
  // the destination, and a village three valleys away must not displace it.
  layers.push(...peakLayers('major', options.units), ...peakLayers('minor', options.units));

  return layers;
}

/**
 * Named summits, in two tiers. Two layer pairs rather than one zoom-dependent rank filter
 * because MapLibre only accepts `["zoom"]` as the direct input of a top-level `step` or
 * `interpolate`; splitting on rank and letting `minzoom` do the zoom half says the same thing.
 * Without the rank filter a Cascade viewport at z12 is a solid field of orange text.
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
        // Lesser summits step back rather than disappear, so crossing z13 gains detail rather
        // than a second layer of shouting.
        'text-opacity': major ? 1 : 0.75,
        'text-halo-color': field.canvas,
        'text-halo-width': 1.4,
      },
    },
  ];
}
