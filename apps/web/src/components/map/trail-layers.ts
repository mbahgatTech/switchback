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
 * The trail layers and everything that pushes data or state into them. Plain functions over a
 * `Map` instance, so `trail-map.tsx` and the iOS WebView at `/embed/map` share one definition.
 *
 * Every line is the woodland plate whatever its difficulty: survey is reserved product-wide
 * for the user and their safety, and a third of any mountain viewport is `hard`. Selection is
 * carried by weight and a halo instead.
 */

/**
 * A trail as the layers need it. Declaring the minimum rather than taking the whole row is
 * what lets these functions also serve a stored bundle or a planned route; `TrailMapItem`
 * satisfies it structurally.
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
 * Where lines give way to counts: below this a viewport holds more trails than it has pixels,
 * and an 18px hit target overlaps every neighbour. Eleven is roughly where a z9 ingest tile
 * stops being larger than the screen.
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
 * The same trails as one point each, for the cluster source. The bbox centre rather than a
 * true centroid: at a zoom where the whole trail is a few pixels the difference is under the
 * cluster radius, and the bbox is already on the row.
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
 * Push both trail sources at once; false when the style has no sources yet.
 *
 * `getSource` returns undefined before the style's first load and again during a basemap
 * swap, so without the boolean `setData` silently does nothing and the caller believes it
 * delivered. Both sources are checked before either is written, so the line layer and the
 * point layer can never hold different sets of trails.
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
 * Move the camera to hold `bbox`. The padding buys breathing room at the frame edge so a
 * trail filling its bounding box does not touch the border and read as clipped.
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
 * You, on the map — the only thing in this module drawn in the survey plate. The ring is the
 * reported accuracy at map scale, so a fix good to eight metres is a dot and one good to
 * ninety is a circle somebody can judge against the path.
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

  // Web Mercator's scale depends on latitude, so the metres-to-pixels conversion is computed
  // against the fix's own latitude and handed over as a zoom-0 radius; the exponential-base-2
  // interpolation is the map's own scaling, so the ring stays the same patch of ground.
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
 * The id of the basemap's lowest label layer, or `undefined` if it has none. Area overlays are
 * inserted before it so a translucent wash cannot erase the toponyms underneath. Found by type
 * rather than by name because the id scheme belongs to whichever style is loaded.
 */
function firstSymbolLayerId(instance: MapLibreMap): string | undefined {
  return instance.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;
}

/**
 * Three layers per trail plus the cluster set, bottom to top.
 *
 * The casing is what makes a green line legible over both a green hillside and white snow.
 * The hit layer is invisible and 18px wide while the drawn line stays hairline — on a phone
 * it is the only reason a tap lands. Above `CLUSTER_ZOOM` the lines draw and the cluster set
 * is hidden; below it, the reverse, so the two never overlap.
 */
export function addTrailLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;
  // Computed once, before anything is added, so the two overlays land in the order they are
  // written here rather than both jumping ahead of whichever was inserted first.
  const labels = firstSymbolLayerId(instance);

  // Air quality first, so every trail layer sits above it: an overlay strong enough to read at
  // a glance would otherwise swallow a 2px green hairline.
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

  // The heatmap sits between air quality and the trail lines: a reader comparing the two
  // wants the human record above the atmospheric one, and both below the lines.
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
        // Selected is brighter as well as wider: width alone is ambiguous at a glance on a
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
        // times as many. Three stops on a log-ish curve approximate `sqrt` closely enough.
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
        // The number *is* the mark, so it must never be dropped for collision, and it must
        // not steal a click from the circle.
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
      // A filter rather than `feature-state`: a clustered source re-keys its features on
      // every zoom, so the trail id lives in the properties instead.
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-color': field.ink,
        'circle-radius': 8,
        'circle-stroke-width': 2,
        'circle-stroke-color': CASING,
      },
    });
  }

  // The open trail, drawn at every zoom and so with no `minzoom`. `fit` on a very long trail
  // lands below `CLUSTER_ZOOM`, where the line layers above have already switched off — the
  // map would fly to exactly the right place and show a dot.
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
