import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import { ATTRIBUTION, type UnitSystem } from '@switchback/core';
import { ELEVATION_BANDS, SCHEMES } from '@switchback/ui';
import {
  BAND_ELEVATIONS_M,
  demSource,
  glyphsUrl,
  LABEL_NAME,
  openMapTilesUrl,
  peakTextField,
} from '../map/basemap';

/**
 * The ground, printed. A second style builder rather than a flag on `buildStyle`, because
 * almost nothing about a lit screen in a dark room survives the change of medium.
 *
 * The cartography does not change: the same `ELEVATION_BANDS` ramp at the same elevations,
 * laid on white and held to about a third strength. Everything else follows from ink on paper
 * — the hillshade loses its highlight (the sheet is the highlight), line weights come down,
 * and there is no terrain, sky or slope overlay on a drawing made from directly overhead.
 */

/** The face's own base tone, under the tint — the paper the mapped area is printed on. */
const PAPER = SCHEMES.sheet.canvas;

/**
 * Water in the hypsometric ramp, chosen to survive printing at a third strength. The screen
 * ramp's `#16323D` comes out a flat warm grey laid on white at 0.3.
 */
const PRINT_WATER = '#2E7CA3';

/** Lakes and rivers from vector data, as a printed sheet fills them: pale, flat, unmistakable. */
const PRINT_WATER_BODY = '#BBD7E4';

/**
 * The shadow the relief is drawn in. Grey-green rather than grey: a neutral shadow turns every
 * band the same way and flattens the ramp into one muddy scale.
 */
const PRINT_SHADE = '#48534D';

const DEM_SOURCE = 'terrain-dem';
const OMT_SOURCE = 'openmaptiles';

/**
 * `[elev, colour, elev, colour, …]` for `color-relief-color`, in printing inks. Same bands at
 * the same elevations as the screen; the two sub-zero stops are what give a coastline an edge.
 */
function printRamp(): (number | string)[] {
  const stops: (number | string)[] = [-2000, PRINT_WATER, -1, PRINT_WATER];
  ELEVATION_BANDS.forEach((color, index) => {
    stops.push(BAND_ELEVATIONS_M[index] ?? 4200, color);
  });
  return stops;
}

/**
 * Ease relief back as the sheet's ratio grows: a 1:25 000 sheet is about zoom 12.9 and a
 * 1:10 000 about 14.2, which is where a pixel passes the DEM's ~90 m spacing and the shading
 * starts drawing its own sampling grid. Eased less far than the screen's, because a reader
 * holding a sheet cannot pinch out.
 */
function easeByZoom(near: number, far: number): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 11, near, 15, far];
}

/**
 * The style the printed face is drawn with. No look options: two readers holding the same
 * printout must not be in front of two different maps.
 *
 * `named` is a division of labour, not a look option — the sheet draws its own summits from our
 * data, and without this the basemap prints the same names again a few millimetres away.
 * `units` is required for the same reason every other number on the sheet is in the reader's
 * system: a summit height in metres among them is a misreading waiting to happen.
 */
export function printSheetStyle(named: readonly string[], units: UnitSystem): StyleSpecification {
  const sheet = SCHEMES.sheet;

  // A missing `name` is common on OSM peaks, and `in` against a null needle is an error
  // rather than a miss — so it is coalesced to a string no waypoint can be called.
  const peakFilter: ExpressionSpecification = [
    'all',
    ['==', ['geometry-type'], 'Point'],
    ['!', ['in', ['coalesce', ['get', 'name'], ''], ['literal', [...named]]]],
  ];

  return {
    version: 8,
    glyphs: glyphsUrl(),
    sources: {
      [DEM_SOURCE]: demSource(),
      [OMT_SOURCE]: {
        type: 'vector',
        url: openMapTilesUrl(),
        attribution: `<a href="${ATTRIBUTION.openFreeMap.href}">${ATTRIBUTION.openFreeMap.label}</a>`,
      },
    },
    layers: [
      { id: 'paper', type: 'background', paint: { 'background-color': PAPER } },

      {
        id: 'hypsometric',
        type: 'color-relief',
        source: DEM_SOURCE,
        paint: {
          'color-relief-color': ['interpolate', ['linear'], ['elevation'], ...printRamp()],
          // A third, falling to a sixth. Any stronger and the black plate — route, neatline,
          // names — has to fight a colour wash to be read.
          'color-relief-opacity': easeByZoom(0.34, 0.16),
        },
      },

      {
        id: 'hillshade',
        type: 'hillshade',
        source: DEM_SOURCE,
        paint: {
          // Northwest, the cartographic convention. Light from any other quarter inverts the
          // relief and a reader perceives every ridge as a gully.
          'hillshade-illumination-direction': 315,
          'hillshade-exaggeration': easeByZoom(0.42, 0.2),
          'hillshade-shadow-color': PRINT_SHADE,
          // The paper is the highlight; ink cannot make part of a sheet brighter than the sheet.
          'hillshade-highlight-color': '#FFFFFF',
          'hillshade-accent-color': PRINT_SHADE,
        },
      },

      {
        id: 'omt-water',
        type: 'fill',
        source: OMT_SOURCE,
        'source-layer': 'water',
        // Intermittent water is a dry bed for most of the year, and printing it as a lake has
        // sent people looking for water that is not there.
        filter: ['!=', ['get', 'intermittent'], 1],
        paint: { 'fill-color': PRINT_WATER_BODY, 'fill-outline-color': sheet.water },
      },
      {
        id: 'omt-waterway',
        type: 'line',
        source: OMT_SOURCE,
        'source-layer': 'waterway',
        minzoom: 9,
        paint: {
          'line-color': sheet.water,
          'line-opacity': 0.8,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.3, 14, 0.8, 18, 1.8],
        },
      },

      {
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
          'line-color': sheet.inkMuted,
          'line-opacity': 0.6,
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 0.8, 16, 2.4],
        },
      },
      {
        id: 'omt-paths',
        type: 'line',
        source: OMT_SOURCE,
        'source-layer': 'transportation',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]],
        paint: {
          'line-color': sheet.inkMuted,
          'line-opacity': 0.45,
          'line-dasharray': [3, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 18, 1.2],
        },
      },

      {
        id: 'omt-place-labels',
        type: 'symbol',
        source: OMT_SOURCE,
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'hamlet']]],
        layout: {
          'text-field': LABEL_NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 9, 14, 11],
          'text-letter-spacing': 0.06,
          // Lower rank is a bigger place. Where two labels collide, the town survives.
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: {
          'text-color': sheet.ink,
          'text-halo-color': '#FFFFFF',
          'text-halo-width': 1.2,
        },
      },
      {
        id: 'omt-water-labels',
        type: 'symbol',
        source: OMT_SOURCE,
        'source-layer': 'water_name',
        minzoom: 9,
        layout: {
          'text-field': LABEL_NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 8, 14, 10],
          'text-letter-spacing': 0.12,
          'text-max-width': 8,
        },
        paint: {
          'text-color': sheet.water,
          'text-halo-color': '#FFFFFF',
          'text-halo-width': 1.1,
        },
      },

      /*
       * Peaks last, so they win every label collision. One tier rather than the screen's two:
       * a sheet is printed at one ratio, so which peaks belong on it is settled when the
       * reader picks the scale, and the rank cut moves with that ratio instead.
       */
      {
        id: 'omt-peak-marks',
        type: 'circle',
        source: OMT_SOURCE,
        'source-layer': 'mountain_peak',
        minzoom: 9,
        filter: peakFilter,
        paint: {
          'circle-radius': 1.6,
          'circle-color': sheet.contour,
          'circle-stroke-width': 0.6,
          'circle-stroke-color': '#FFFFFF',
        },
      },
      {
        id: 'omt-peak-labels',
        type: 'symbol',
        source: OMT_SOURCE,
        'source-layer': 'mountain_peak',
        minzoom: 9,
        filter: peakFilter,
        layout: {
          'text-field': peakTextField(units),
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 14, 10.5],
          'text-letter-spacing': 0.04,
          'text-offset': [0, 0.7],
          'text-anchor': 'top',
          'text-max-width': 9,
          'symbol-sort-key': ['coalesce', ['get', 'rank'], 99],
        },
        paint: {
          'text-color': sheet.contour,
          'text-halo-color': '#FFFFFF',
          'text-halo-width': 1.2,
        },
      },
    ],
  };
}
