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
 * The ground, printed.
 *
 * A second style builder rather than a `scheme` flag on the first one, and the reason is
 * that almost nothing about `buildStyle` survives the change of medium. Its ground tint is a
 * dark olive, its hillshade casts a near-black shadow and lifts a warm white highlight, its
 * labels are pale ink on a near-black canvas. Every one of those is a decision about a lit
 * screen in a dark room. On paper the light comes from the room, not the sheet, and each of
 * them inverts independently — a flag would be a flag threaded through two hundred lines.
 *
 * What does not change is the cartography. `ELEVATION_BANDS` carries a doc comment declaring
 * itself scheme-independent — "the same colour on paper, on the phone at night, and on the
 * website, exactly as it would be on a printed sheet" — and this is the sheet that comment
 * was describing. So the ramp is the same ramp at the same elevations, laid on white instead
 * of on olive and held to about a third strength, which is what turns a screen tint into a
 * paper one. A reader who has been looking at the relief base all week gets the map they
 * already know how to read, in the tones a printer can actually put down.
 *
 * Everything else follows from ink on paper:
 *
 * - **The hillshade loses its highlight.** On a screen, lit slopes are painted brighter than
 *   the ground. On paper there is nothing brighter than the paper, so only the shadow is
 *   printed and the highlight is the sheet showing through.
 * - **Line weights come down.** A 300 dpi printer resolves about a tenth of a millimetre; a
 *   screen never resolves better than a quarter. Roads and paths that read as quiet on a
 *   monitor print as heavy, so they are set thinner and paler than their screen equivalents.
 * - **No terrain, no sky, no slope overlay.** A sheet is a drawing made from directly
 *   overhead. Pitch is not available to it and neither is the question of what sits above the
 *   horizon.
 */

/** The face's own base tone, under the tint — the paper the mapped area is printed on. */
const PAPER = SCHEMES.sheet.canvas;

/**
 * Water in the hypsometric ramp, chosen to survive being printed at a third strength.
 *
 * The screen ramp's `#16323D` is tuned for an ocean seen at continental zoom against a
 * near-black page, where near-black is right. Laid on white at 0.3 it comes out a flat
 * warm grey — the colour of a smudge rather than of the sea. A lighter, more saturated blue
 * lands where a printed sheet's water lands.
 */
const PRINT_WATER = '#2E7CA3';

/** Lakes and rivers from vector data, as a printed sheet fills them: pale, flat, unmistakable. */
const PRINT_WATER_BODY = '#BBD7E4';

/**
 * The shadow the relief is drawn in.
 *
 * Grey-green rather than grey. A neutral shadow over a hypsometric tint turns every band
 * the same way and flattens the ramp into one muddy scale; carrying a trace of the
 * ground's own hue keeps a shaded valley reading as a valley rather than as a stain.
 */
const PRINT_SHADE = '#48534D';

const DEM_SOURCE = 'terrain-dem';
const OMT_SOURCE = 'openmaptiles';

/**
 * `[elev, colour, elev, colour, …]` for `color-relief-color`, in printing inks.
 *
 * Same bands at the same elevations as the screen. Only the two sub-zero stops differ, and
 * they differ because they are the ones doing a job the ramp cannot do on its own: giving a
 * coastline an edge rather than letting the sea interpolate up into valley green.
 */
function printRamp(): (number | string)[] {
  const stops: (number | string)[] = [-2000, PRINT_WATER, -1, PRINT_WATER];
  ELEVATION_BANDS.forEach((color, index) => {
    stops.push(BAND_ELEVATIONS_M[index] ?? 4200, color);
  });
  return stops;
}

/**
 * Ease relief back as the sheet's ratio grows, exactly as the screen does and for the same
 * reason — with one difference in where the ladder sits.
 *
 * Terrarium samples about 90 m apart at temperate latitudes. A 1:25 000 sheet works out at
 * roughly zoom 12.9 and a 1:10 000 sheet at 14.2, so the large-scale end of the paper ladder
 * runs straight through the zoom where a screen pixel passes the DEM's own spacing and the
 * shading stops describing terrain and starts drawing its sampling grid.
 *
 * It eases less far than the screen's does, though, because paper does not have the screen's
 * escape route. A reader who wants relief on a monitor pinches out; a reader holding a sheet
 * has the sheet. So the shading fades toward a whisper rather than toward nothing, which is
 * also what a printed large-scale series does — relief on the small-scale sheet, and enough
 * of it on the large-scale one to say which way the ground falls.
 */
function easeByZoom(near: number, far: number): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 11, near, 15, far];
}

/**
 * The style the printed face is drawn with.
 *
 * No look options. A sheet has one look — that is most of what makes it a sheet — and every
 * knob this could have taken is a knob that would put two readers holding the same printout
 * in front of two different maps.
 *
 * `named` is not a look option; it is a division of labour. The sheet draws its own summits
 * as triangles and names them from our data, and the basemap has the same peaks in
 * `mountain_peak` with the same names. Left alone the two collide — "Mount Assiniboine"
 * printed twice, eight millimetres apart, over its own triangle and a stray circle. Passing
 * the names the sheet is drawing itself tells the ground layer to stay out of their way. Our
 * marks are the authority for what they name; the basemap fills in everything around them.
 *
 * `units` is not a look option either, for a reason worth stating on a sheet in particular:
 * this is the map that gets folded into a pocket and read at the col with no way to ask the
 * app what it meant. Every other number printed on it — the profile axis, the stat block, the
 * scale bar — is in the reader's system, and a summit height in metres among them is not a
 * second opinion, it is a misreading waiting to happen. Required, and `named` gave up its
 * default to keep it so; there is one caller, and a default here would be the same quiet
 * fallback to metric that put this on the list.
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
          // A third, falling to a sixth. Any stronger and the black plate — the route, the
          // neatline, the names — has to fight a colour wash to be read, which is the failure
          // mode of every hypsometric sheet that has ever been printed badly.
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
          // The paper is the highlight. Printing one would mean laying ink down to make part
          // of the sheet brighter than the sheet, which is not a thing ink does.
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
       * Peaks last, so they win every label collision.
       *
       * One tier rather than the screen's two. The screen splits them because its zoom runs
       * from a continent to a crag and a rank filter cannot be written as a function of zoom;
       * a sheet is printed at one ratio, and which peaks belong on it is settled once, at the
       * moment the reader picks the scale. The rank cut moves with that ratio instead.
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
