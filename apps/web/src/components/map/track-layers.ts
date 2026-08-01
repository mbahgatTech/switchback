import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { SCHEMES } from '@switchback/ui';
import { CASING } from './basemap';

/**
 * A finished hike: one line and two marks, shared by the activity page and the same map inside
 * the iOS `WebView`, so the phone and the browser cannot draw a hike differently.
 *
 * The track is contour and is the only line — the trail it was recorded against is
 * deliberately absent, since afterwards two nearly-coincident lines read as one thick one.
 * Start is hollow and finish filled, so an out-and-back's two ends stay distinguishable.
 */

export const TRACK_SOURCE = 'act-track';
export const TRACK_ENDS_SOURCE = 'act-ends';
export const TRACK_CASING_LAYER = 'act-track-casing';
export const TRACK_LINE_LAYER = 'act-track-line';
export const TRACK_ENDS_LAYER = 'act-ends';

/** Slack around the track when framing it. Enough that the line never touches an edge. */
export const TRACK_FIT_PADDING_PX = 48;

/** A track this far zoomed in is a GPS scatter plot, not a hike. */
const TRACK_MAX_ZOOM = 15;

export type TrackPoint = readonly [number, number] | readonly [number, number, number | null];

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Add the source and the three layers. Idempotent, because a base-map change tears the style
 * down and this is called again on the far side of it.
 */
export function addTrackLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;

  if (!instance.getSource(TRACK_SOURCE)) {
    instance.addSource(TRACK_SOURCE, { type: 'geojson', data: EMPTY });
  }
  if (!instance.getSource(TRACK_ENDS_SOURCE)) {
    instance.addSource(TRACK_ENDS_SOURCE, { type: 'geojson', data: EMPTY });
  }

  if (!instance.getLayer(TRACK_CASING_LAYER)) {
    instance.addLayer({
      id: TRACK_CASING_LAYER,
      type: 'line',
      source: TRACK_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      // Near-black rather than a plate colour: a shadow that lifts the line off whatever it
      // crosses, not a separation in its own right.
      paint: { 'line-color': CASING, 'line-opacity': 0.7, 'line-width': 8 },
    });
  }
  if (!instance.getLayer(TRACK_LINE_LAYER)) {
    instance.addLayer({
      id: TRACK_LINE_LAYER,
      type: 'line',
      source: TRACK_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.contour, 'line-width': 4 },
    });
  }
  if (!instance.getLayer(TRACK_ENDS_LAYER)) {
    instance.addLayer({
      id: TRACK_ENDS_LAYER,
      type: 'circle',
      source: TRACK_ENDS_SOURCE,
      paint: {
        'circle-radius': 6,
        // Hollow start, filled finish. See the note at the top of the file.
        'circle-color': ['case', ['==', ['get', 'end'], 'finish'], field.contour, field.canvas],
        'circle-stroke-color': [
          'case',
          ['==', ['get', 'end'], 'finish'],
          field.canvas,
          field.contour,
        ],
        'circle-stroke-width': 2.5,
      },
    });
  }
}

/** Put a line on, or take it off. Fewer than two points is nothing to draw. */
export function setTrack(instance: MapLibreMap, track: readonly TrackPoint[]): void {
  const line = instance.getSource<GeoJSONSource>(TRACK_SOURCE);
  const ends = instance.getSource<GeoJSONSource>(TRACK_ENDS_SOURCE);
  if (!line || !ends) return;

  if (track.length < 2) {
    line.setData(EMPTY);
    ends.setData(EMPTY);
    return;
  }

  const first = track[0]!;
  const last = track[track.length - 1]!;

  line.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: track.map(([lng, lat]) => [lng, lat]) },
      },
    ],
  });
  ends.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { end: 'start' },
        geometry: { type: 'Point', coordinates: [first[0], first[1]] },
      },
      {
        type: 'Feature',
        properties: { end: 'finish' },
        geometry: { type: 'Point', coordinates: [last[0], last[1]] },
      },
    ],
  });
}

/** The box the whole track sits in, or null if there is no track to bound. */
export function trackBounds(track: readonly TrackPoint[]): maplibregl.LngLatBounds | null {
  const first = track[0];
  if (!first) return null;
  const bounds = new maplibregl.LngLatBounds([first[0], first[1]], [first[0], first[1]]);
  for (const [lng, lat] of track) bounds.extend([lng, lat]);
  return bounds;
}

/**
 * Frame the camera on the track, capped at z15: a hike recorded standing still is a cluster of
 * fixes a few metres across, and fitting to it would put the camera underground.
 */
export function fitTrack(
  instance: MapLibreMap,
  track: readonly TrackPoint[],
  padding: number | { top: number; bottom: number; left: number; right: number },
): void {
  const bounds = trackBounds(track);
  if (!bounds) return;
  instance.fitBounds(bounds, { padding, maxZoom: TRACK_MAX_ZOOM, duration: 0 });
}
