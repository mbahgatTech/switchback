import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import type { BBox, Difficulty } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';
import { CASING } from './basemap';
import {
  AIR_QUALITY_LAYER,
  AIR_QUALITY_SOURCE,
  EMPTY_AIR_QUALITY,
  airQualityFillColor,
  airQualityOutlineColor,
} from './air-quality';
import { EMPTY_HEATMAP, HEATMAP_LAYER, HEATMAP_SOURCE, heatmapFillColor } from './heatmap';

/**
 * The trail layers, and everything that pushes data or state into them.
 *
 * Extracted from `trail-map.tsx` so the phone can draw the same map. The iOS explore screen
 * is MapLibre GL JS in a `WebView` pointed at `/embed/map`, and the whole argument for that
 * arrangement is that there is exactly one definition of what a trail looks like on a map.
 * Two implementations that "match" is a promise nobody can keep past the first change.
 *
 * Everything here is plain functions over a `Map` instance — no React, no state — because
 * the two callers hold their map differently and the layers do not care which.
 *
 * **On colour.** Every line is the woodland plate, whatever its difficulty. Colouring by
 * difficulty is the obvious move and it is wrong here: a third of any mountain viewport is
 * `hard`, so the map would be flooded with the survey plate — the one colour reserved for
 * the user and their safety, which on the phone is the position dot on this exact screen.
 * Selection is carried by weight and a halo instead, which is emphasis rather than a second
 * meaning, and leaves the legend intact.
 */

/**
 * A trail as the layers need it, which is much less than a trail is.
 *
 * Every field here is drawn: the geometry is the line, the bbox is the clustered dot and the
 * frame a selection flies to, and the two scalars are feature properties. `TrailMapItem`
 * satisfies it structurally, so the callers pass what `browse` returned without a mapping
 * step; declaring the minimum instead of taking the whole row is what lets these functions
 * also serve a stored bundle, a planned route, or anything else with a line and a box.
 */
export interface MapTrail {
  id: string;
  name: string;
  difficulty: Difficulty;
  bbox: BBox;
  geometry: LineString;
}

export const SOURCE_ID = 'trails';
export const POINT_SOURCE_ID = 'trail-points';
export const CASING_LAYER = 'trail-casing';
export const LINE_LAYER = 'trail-line';
export const HIT_LAYER = 'trail-hit';
export const SELECTED_CASING_LAYER = 'trail-selected-casing';
export const SELECTED_LAYER = 'trail-selected';
export const CLUSTER_LAYER = 'trail-cluster';
export const CLUSTER_COUNT_LAYER = 'trail-cluster-count';
export const POINT_LAYER = 'trail-point';
export const POINT_ACTIVE_LAYER = 'trail-point-active';

/**
 * Where lines give way to counts.
 *
 * Below this, a viewport holds more trails than it has pixels to draw them in: a hundred
 * hairlines over a mountain range is a green smear that says nothing about how many trails
 * are there, and its eighteen-pixel hit target overlaps every neighbour, so pointing at one
 * is a lottery. A cluster answers the question that zoom level is actually asking — *is
 * there anything here, and how much* — and it answers it in a number.
 *
 * Eleven, because that is roughly where a z9 ingest tile stops being larger than the screen.
 * Above it you are looking at one valley and the lines are the point; below it you are
 * choosing which valley.
 */
export const CLUSTER_ZOOM = 11;

export function toFeatureCollection(trails: readonly MapTrail[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: trails.map((trail) => ({
      type: 'Feature',
      id: trail.id,
      properties: { id: trail.id, name: trail.name, difficulty: trail.difficulty },
      geometry: trail.geometry,
    })),
  };
}

/**
 * The same trails as one point each, for the cluster source.
 *
 * The centre of the bounding box rather than a true centroid of the line. For a loop they
 * are the same point; for a switchbacking climb they differ by less than the cluster radius,
 * which is the only distance that matters at a zoom where the whole trail is a few pixels
 * long. It also costs nothing — the bbox is already on the row.
 */
export function toPointCollection(trails: readonly MapTrail[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: trails.map((trail) => {
      const [w, s, e, n] = trail.bbox;
      return {
        type: 'Feature',
        properties: { id: trail.id, name: trail.name },
        geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + n) / 2] },
      };
    }),
  };
}

export function boundsOf(map: MapLibreMap): BBox {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

/**
 * Push both trail sources at once, and say whether it landed.
 *
 * The boolean is the point of this function. `getSource` returns undefined for every moment
 * before the style's first load, and again for the window during a basemap swap when
 * `setStyle` has torn the layers down and they have not gone back on yet — so the two
 * `setData` calls quietly do nothing and the function returns as if it had worked. That
 * silence is the whole of the "trails never land" failure: a correct query, a correct
 * response, a caller that believes it delivered, and an empty map with nothing anywhere
 * saying why.
 *
 * Both sources are checked before either is written, so the line layer and the point layer
 * can never end up holding different sets of trails.
 */
export function setTrailData(instance: MapLibreMap, trails: readonly MapTrail[]): boolean {
  const lines = instance.getSource<GeoJSONSource>(SOURCE_ID);
  const points = instance.getSource<GeoJSONSource>(POINT_SOURCE_ID);
  if (!lines || !points) return false;

  lines.setData(toFeatureCollection(trails));
  points.setData(toPointCollection(trails));
  return true;
}

/**
 * Move the camera to hold `bbox`.
 *
 * The padding is symmetric and generous because the panel that crowds this map is a sibling
 * in the grid, not an overlay — the map's own box is already the free space. What it does
 * buy is breathing room at the frame edge, so a trail that fills its bounding box does not
 * touch the canvas border on all four sides and read as clipped.
 */
export function fit(
  instance: MapLibreMap,
  bbox: BBox,
  maxZoom: number,
  padding: { top: number; bottom: number; left: number; right: number } = {
    top: 64,
    bottom: 64,
    left: 64,
    right: 64,
  },
): void {
  const [w, s, e, n] = bbox;
  instance.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    {
      padding,
      maxZoom,
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 620,
    },
  );
}

/** Toggle one feature-state flag from the old id to the new one. */
export function applyState(
  instance: MapLibreMap,
  key: 'hovered' | 'selected',
  from: string | null,
  to: string | null,
): void {
  if (!instance.getSource(SOURCE_ID)) return;
  if (from) instance.setFeatureState({ source: SOURCE_ID, id: from }, { [key]: false });
  if (to) instance.setFeatureState({ source: SOURCE_ID, id: to }, { [key]: true });
}

/** Point the highlight ring at one trail, or at nothing. */
export function setActivePoint(instance: MapLibreMap, trailId: string | null): void {
  if (!instance.getLayer(POINT_ACTIVE_LAYER)) return;
  instance.setFilter(POINT_ACTIVE_LAYER, ['==', ['get', 'id'], trailId ?? '']);
}

/** Draw one trail's line irrespective of zoom, or none. */
export function setSelectedLine(instance: MapLibreMap, trailId: string | null): void {
  for (const layer of [SELECTED_CASING_LAYER, SELECTED_LAYER]) {
    if (instance.getLayer(layer)) {
      instance.setFilter(layer, ['==', ['get', 'id'], trailId ?? '']);
    }
  }
}

/**
 * You, on the map.
 *
 * The only thing anywhere in this module drawn in the survey plate. That plate is reserved
 * product-wide for the user and their safety, and this is the one mark on a map that is
 * about the person holding it rather than the ground under them — which is exactly why the
 * trail lines stay woodland however hard they are. If everything urgent is red, nothing is.
 *
 * The ring is real, not decoration: it is the reported accuracy drawn at the scale of the
 * map, so a fix good to eight metres is a dot and a fix good to ninety is a circle you can
 * see. Somebody deciding whether they are on the path or beside it needs that difference.
 */
export const LOCATE_SOURCE = 'locate';
export const LOCATE_ACCURACY_LAYER = 'locate-accuracy';
export const LOCATE_DOT_LAYER = 'locate-dot';

export function addLocateLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;

  if (!instance.getSource(LOCATE_SOURCE)) {
    instance.addSource(LOCATE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }

  if (!instance.getLayer(LOCATE_ACCURACY_LAYER)) {
    instance.addLayer({
      id: LOCATE_ACCURACY_LAYER,
      type: 'circle',
      source: LOCATE_SOURCE,
      paint: {
        'circle-color': field.survey,
        'circle-opacity': 0.14,
        // Replaced by `setLocate` once there is a fix to size it against.
        'circle-radius': 0,
        'circle-stroke-width': 1,
        'circle-stroke-color': field.survey,
        'circle-stroke-opacity': 0.4,
      },
    });
  }

  if (!instance.getLayer(LOCATE_DOT_LAYER)) {
    instance.addLayer({
      id: LOCATE_DOT_LAYER,
      type: 'circle',
      source: LOCATE_SOURCE,
      paint: {
        'circle-color': field.survey,
        'circle-radius': 6,
        // A light collar, so the dot survives being over a dark forest or a red slope band.
        'circle-stroke-width': 2,
        'circle-stroke-color': field.ink,
      },
    });
  }
}

/** Ground-metres per screen pixel at zoom 0, which halves with every zoom level. */
const EQUATOR_M_PER_PX = 156_543.033_92;

/** Move the position mark, or take it off. `accuracyM` of `null` draws no ring. */
export function setLocate(
  instance: MapLibreMap,
  position: readonly [number, number] | null,
  accuracyM: number | null,
): void {
  const source = instance.getSource<GeoJSONSource>(LOCATE_SOURCE);
  if (!source) return;

  source.setData({
    type: 'FeatureCollection',
    features: position
      ? [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [position[0], position[1]] },
          },
        ]
      : [],
  });

  if (!instance.getLayer(LOCATE_ACCURACY_LAYER)) return;
  if (!position || accuracyM == null || accuracyM <= 0) {
    instance.setPaintProperty(LOCATE_ACCURACY_LAYER, 'circle-radius', 0);
    return;
  }

  /*
   * A radius in metres, expressed in the only unit `circle-radius` speaks.
   *
   * Web Mercator's scale depends on latitude, so the conversion is computed here against the
   * fix's own latitude and handed to MapLibre as the zoom-0 radius; the exponential-base-2
   * interpolation is then exactly the map's own scaling, which means the ring stays the same
   * patch of ground through a pinch instead of swelling or shrinking against the terrain.
   */
  const atZeroPx = accuracyM / (EQUATOR_M_PER_PX * Math.cos((position[1] * Math.PI) / 180));
  instance.setPaintProperty(LOCATE_ACCURACY_LAYER, 'circle-radius', [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    0,
    atZeroPx,
    22,
    atZeroPx * 2 ** 22,
  ]);
}

/**
 * The id of the basemap's lowest label layer, or `undefined` if it has none.
 *
 * Area overlays are inserted before it so that place names, summit heights and contour
 * labels stay on top of them. Without this every fill is appended to the end of the layer
 * list — above the basemap's own symbols — and a translucent wash quietly erases the
 * toponyms underneath. "Yr Wyddfa 1085 m" disappearing under a heatmap cell is not a
 * cosmetic loss: on a hill map the labels are how you know which hill you are looking at.
 *
 * Symbol layers are found by type rather than by name because the id scheme belongs to
 * whichever style is loaded — OpenFreeMap's, the satellite style's, or a future self-hosted
 * one — and a hardcoded id would silently return `undefined` the day one of them changes,
 * putting the wash back over the labels with no error anywhere.
 */
function firstSymbolLayerId(instance: MapLibreMap): string | undefined {
  return instance.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;
}

/**
 * Three layers per trail plus the cluster set, bottom to top.
 *
 * The casing is what makes a green line legible over both a green hillside and white snow —
 * a dark outline is the cartographic answer to "this has to work on any ground", and it is
 * why a single-layer line always looks wrong on satellite. The hit layer is invisible and
 * wide: a 2 px line is a 2 px pointer target, which is unusable, so the target is 18 px
 * while the drawn line stays hairline. On a phone that number is doing even more work — a
 * fingertip is tens of pixels across, and the hit layer is the only reason a tap lands.
 *
 * Above `CLUSTER_ZOOM` those three draw and the cluster set is hidden; below it, the reverse.
 * The two sets never overlap, so there is no zoom at which a trail is both a line and a dot.
 */
export function addTrailLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;
  // Computed once, before anything is added, so the two overlays land in the order they are
  // written here rather than both jumping ahead of whichever was inserted first.
  const labels = firstSymbolLayerId(instance);

  /*
   * Air quality goes on first, so every trail layer added below sits above it.
   *
   * That order is the whole argument for putting it here rather than in `buildStyle`: an
   * overlay strong enough to be read at a glance is strong enough to swallow a 2 px green
   * hairline, and the trails are what the map is for. Painted under them, a red cell reads
   * as the air *around* a route rather than as something wrong with the route.
   */
  if (!instance.getSource(AIR_QUALITY_SOURCE)) {
    instance.addSource(AIR_QUALITY_SOURCE, { type: 'geojson', data: EMPTY_AIR_QUALITY });
  }

  if (!instance.getLayer(AIR_QUALITY_LAYER)) {
    instance.addLayer(
      {
        id: AIR_QUALITY_LAYER,
        type: 'fill',
        source: AIR_QUALITY_SOURCE,
        paint: {
          'fill-color': airQualityFillColor() as unknown as ExpressionSpecification,
          // One-pixel, non-scaling, and in the band's own hue: the seam between two equal
          // cells is what tells a reader this is a grid of measurements and not a wash.
          'fill-outline-color': airQualityOutlineColor() as unknown as ExpressionSpecification,
        },
      },
      labels,
    );
  }

  /*
   * The heatmap sits directly above air quality and still below every trail line.
   *
   * Between the two, rather than under both, because they answer different questions and a
   * reader comparing them wants the human record on top of the atmospheric one. Under the
   * trails for the same reason air quality is: the wash is at its most useful exactly where
   * it disagrees with a green line, and it can only disagree visibly if the line survives it.
   */
  if (!instance.getSource(HEATMAP_SOURCE)) {
    instance.addSource(HEATMAP_SOURCE, { type: 'geojson', data: EMPTY_HEATMAP });
  }

  if (!instance.getLayer(HEATMAP_LAYER)) {
    instance.addLayer(
      {
        id: HEATMAP_LAYER,
        type: 'fill',
        source: HEATMAP_SOURCE,
        paint: {
          'fill-color': heatmapFillColor() as unknown as ExpressionSpecification,
          // No outline colour and no antialiasing: see the header of `./heatmap` for why
          // drawing this lattice's seams would claim a resolution nobody computed.
          'fill-antialias': false,
        },
      },
      labels,
    );
  }

  if (!instance.getSource(SOURCE_ID)) {
    instance.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      // Lifts our own trail id into the feature id, which is what `setFeatureState` keys on.
      promoteId: 'id',
    });
  }

  if (!instance.getSource(POINT_SOURCE_ID)) {
    instance.addSource(POINT_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: true,
      // One below the handover, so the last clustered zoom is the last zoom that shows dots.
      // Leaving it at the handover would put single un-grouped dots on screen at a zoom
      // where the lines have already taken over.
      clusterMaxZoom: CLUSTER_ZOOM - 1,
      // Roughly a thumb. Tighter and a range breaks into a dozen near-identical circles;
      // looser and two genuinely separate valleys merge into one misleading number.
      clusterRadius: 44,
    });
  }

  const emphasis = (base: number, hovered: number, selected: number) =>
    [
      'case',
      ['boolean', ['feature-state', 'selected'], false],
      selected,
      ['boolean', ['feature-state', 'hovered'], false],
      hovered,
      base,
    ] as unknown as ExpressionSpecification;

  if (!instance.getLayer(CASING_LAYER)) {
    instance.addLayer({
      id: CASING_LAYER,
      type: 'line',
      source: SOURCE_ID,
      minzoom: CLUSTER_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': CASING,
        'line-opacity': 0.55,
        'line-width': emphasis(4, 5.5, 8),
      },
    });
  }

  if (!instance.getLayer(LINE_LAYER)) {
    instance.addLayer({
      id: LINE_LAYER,
      type: 'line',
      source: SOURCE_ID,
      minzoom: CLUSTER_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': field.woodland,
        // Selected is brighter as well as wider. Width alone is ambiguous at a glance on a
        // map holding a hundred lines of varying length.
        'line-opacity': emphasis(0.85, 1, 1),
        'line-width': emphasis(2, 3, 4.5),
      },
    });
  }

  if (!instance.getLayer(HIT_LAYER)) {
    instance.addLayer({
      id: HIT_LAYER,
      type: 'line',
      source: SOURCE_ID,
      minzoom: CLUSTER_ZOOM,
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 18 },
    });
  }

  if (!instance.getLayer(CLUSTER_LAYER)) {
    instance.addLayer({
      id: CLUSTER_LAYER,
      type: 'circle',
      source: POINT_SOURCE_ID,
      maxzoom: CLUSTER_ZOOM,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': field.woodland,
        // Area, not radius, should track the count — a circle twice as wide reads as four
        // times as many. `sqrt` would be exact; three stops on a log-ish curve is close
        // enough and keeps a thousand-trail cluster from swallowing the viewport.
        'circle-radius': ['step', ['get', 'point_count'], 15, 25, 20, 100, 26, 400, 33],
        'circle-opacity': 0.9,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': CASING,
      },
    });
  }

  if (!instance.getLayer(CLUSTER_COUNT_LAYER)) {
    instance.addLayer({
      id: CLUSTER_COUNT_LAYER,
      type: 'symbol',
      source: POINT_SOURCE_ID,
      maxzoom: CLUSTER_ZOOM,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        // The one fontstack `glyphsUrl()` guarantees on every base. See `basemap.ts`.
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-letter-spacing': 0.04,
        // The number is not a label for something else on the map — it *is* the mark, so it
        // must never be dropped for collision, and it must not steal a click from the circle.
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': CASING },
    });
  }

  if (!instance.getLayer(POINT_LAYER)) {
    instance.addLayer({
      id: POINT_LAYER,
      type: 'circle',
      source: POINT_SOURCE_ID,
      maxzoom: CLUSTER_ZOOM,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': field.woodland,
        'circle-radius': 6,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': CASING,
      },
    });
  }

  if (!instance.getLayer(POINT_ACTIVE_LAYER)) {
    instance.addLayer({
      id: POINT_ACTIVE_LAYER,
      type: 'circle',
      source: POINT_SOURCE_ID,
      maxzoom: CLUSTER_ZOOM,
      // Matches nothing until the index says otherwise. A filter rather than `feature-state`
      // because a clustered source re-keys its features on every zoom, so there is no id
      // stable enough to hold state against — the trail id lives in the properties instead.
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-color': field.ink,
        'circle-radius': 8,
        'circle-stroke-width': 2,
        'circle-stroke-color': CASING,
      },
    });
  }

  /*
   * The open trail, drawn at every zoom.
   *
   * Without this pair, selecting a long trail hides it. `fit` zooms out far enough to hold
   * the whole bounding box, and the Pacific Crest Trail's box is two thousand kilometres
   * tall — well under `CLUSTER_ZOOM`, where the line layers above have already switched
   * off. The map would fly to exactly the right place and show a dot. So the selection gets
   * its own casing and line with no `minzoom`: one trail's worth of geometry is never the
   * smear that the ceiling exists to prevent, and it is the one line you have asked to see.
   */
  if (!instance.getLayer(SELECTED_CASING_LAYER)) {
    instance.addLayer({
      id: SELECTED_CASING_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'id'], ''],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': CASING, 'line-opacity': 0.55, 'line-width': 8 },
    });
  }

  if (!instance.getLayer(SELECTED_LAYER)) {
    instance.addLayer({
      id: SELECTED_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['get', 'id'], ''],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.woodland, 'line-width': 4.5 },
    });
  }
}
