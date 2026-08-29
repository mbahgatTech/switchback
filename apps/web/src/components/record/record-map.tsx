'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { LineString } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';
import { CASING, buildStyle } from '../map/basemap';
import { registerRTLText } from '../map/rtl';
import { useScaleBar } from '../map/scale';
import { useUnitsRef } from '../units';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * The map on the recording screen. Separate from the browse and trail maps because this one
 * follows a person: the camera is not the reader's by default and the subject moves.
 *
 * A ribbon and a thread: the trail is a wide woodland line and the recorded track a narrow
 * contour one down the middle of it, so both stay legible where they coincide — which, on a
 * hike that is going well, is everywhere. `map/track-layers.ts` reaches the opposite
 * conclusion for a *finished* hike, where the two lines carry equal weight and a reader has
 * no reason left to tell them apart.
 *
 * Survey is the dot: you, now. The woodland ring under it is where the trail says you are,
 * which is the same place until you leave the trail, and the useful difference afterwards.
 */

export interface RecordMapProps {
  /** The track so far. Redrawn on every fix, so it stays a plain coordinate array. */
  track: ReadonlyArray<readonly [number, number]>;
  /** The trail being followed, if one was chosen. */
  route: LineString | null;
  /** The position projected onto that trail, from the recorder's `progress`. */
  progressAt: readonly [number, number] | null;
  position: readonly [number, number] | null;
  /** Metres. Drawn as a circle under the dot, so a poor fix looks like a poor fix. */
  accuracyM: number | null;
  /** Whether the camera chases the dot. False the moment the reader pans. */
  follow: boolean;
  onUserPan: () => void;
  className?: string;
}

const TRACK_SOURCE = 'rec-track';
const ROUTE_SOURCE = 'rec-route';
const PROGRESS_SOURCE = 'rec-progress';
const POSITION_SOURCE = 'rec-position';

/**
 * The two line weights, in pixels, and the whole of the hierarchy between them. Ten against
 * three, because what has to survive is the *green*: a fix good to seven metres sits about
 * three pixels off the trail at z15, and once the track's own casing is subtracted the trail
 * has three pixels a side left to read as a line rather than as a fringe.
 */
const ROUTE_WIDTH = 10;
const TRACK_WIDTH = 3;

/**
 * Ground metres per screen pixel at zoom 0, taken at 48° north. Web Mercator's scale depends
 * on latitude, so this is a few per cent out across the temperate band — acceptable for a
 * circle whose job is to say "somewhere about here".
 */
const METRES_PER_PIXEL_Z0 = 156_543 * Math.cos((48 * Math.PI) / 180);

/**
 * Where the camera sits before the first fix arrives, in order of usefulness: the position if
 * the browser has one, then the chosen trail framed whole, then a wide regional view. Never a
 * continental zoom — relief tiles at that scale have nothing recognisable in them.
 */
function initialCamera(
  route: LineString | null,
  position: readonly [number, number] | null,
):
  | { center: [number, number]; zoom: number }
  | {
      bounds: [number, number, number, number];
      fitBoundsOptions: { padding: number; maxZoom: number };
    } {
  if (position) return { center: [position[0], position[1]], zoom: 15 };

  const coords = route?.coordinates ?? [];
  if (coords.length >= 2) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    if (Number.isFinite(west) && Number.isFinite(south)) {
      return {
        bounds: [west, south, east, north],
        // Capped, because a 200 m spur framed edge to edge is a map of one bend with no
        // landmark on it. Padding keeps the ends of the line off the chrome.
        fitBoundsOptions: { padding: 48, maxZoom: 14 },
      };
    }
  }

  return { center: [-121.5, 48.0], zoom: 9 };
}

function lineCollection(coords: ReadonlyArray<readonly [number, number]>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      coords.length >= 2
        ? [
            {
              type: 'Feature',
              properties: {},
              // Copied, not cast: GeoJSON's own types are mutable and MapLibre keeps the
              // array it is handed.
              geometry: { type: 'LineString', coordinates: coords.map(([lng, lat]) => [lng, lat]) },
            },
          ]
        : [],
  };
}

/** One point, or none. `accuracyM` is read by the ring layer's radius expression. */
function pointCollection(
  position: readonly [number, number] | null,
  accuracyM: number | null = null,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: position
      ? [
          {
            type: 'Feature',
            properties: { accuracyM: accuracyM ?? 0 },
            geometry: { type: 'Point', coordinates: [position[0], position[1]] },
          },
        ]
      : [],
  };
}

export function RecordMap({
  track,
  route,
  progressAt,
  position,
  accuracyM,
  follow,
  onUserPan,
  className,
}: RecordMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const onUserPanRef = useRef(onUserPan);
  onUserPanRef.current = onUserPan;

  // The current data, kept where the `load` handler can reach it. `route` is passed once and
  // never changes identity, so its effect runs before the sources exist and the line would
  // otherwise never be added at all.
  const latest = useRef({ track, route, progressAt, position, accuracyM });
  latest.current = { track, route, progressAt, position, accuracyM };

  const scaleBar = useScaleBar(110);
  const units = useUnitsRef();

  useEffect(() => {
    if (!container.current || map.current) return;

    registerRTLText();

    const instance = new maplibregl.Map({
      container: container.current,
      // Relief, always. On this screen the only question is where you are, and shaded ground
      // answers it in the dark without a round trip for imagery.
      style: buildStyle('relief', { hillshade: true, units: units.current }),
      ...initialCamera(route, position),
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(scaleBar(), 'bottom-left');

    // Only a gesture releases the camera. `movestart` alone would fire on our own
    // `easeTo`, so follow mode would switch itself off on the first fix it handled.
    const release = (event: { originalEvent?: unknown }): void => {
      if (event.originalEvent) onUserPanRef.current();
    };
    instance.on('dragstart', release);
    instance.on('zoomstart', release);

    instance.on('load', () => {
      ready.current = true;
      addRecordLayers(instance);

      // Whatever arrived while the style was loading — without this the trail line never
      // draws at all. See `latest` above.
      const now = latest.current;
      instance.getSource<GeoJSONSource>(TRACK_SOURCE)?.setData(lineCollection(now.track));
      instance
        .getSource<GeoJSONSource>(ROUTE_SOURCE)
        ?.setData(lineCollection(now.route?.coordinates ?? []));
      instance.getSource<GeoJSONSource>(PROGRESS_SOURCE)?.setData(pointCollection(now.progressAt));
      if (now.position) {
        instance
          .getSource<GeoJSONSource>(POSITION_SOURCE)
          ?.setData(pointCollection(now.position, now.accuracyM));
      }
    });

    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
    };
    // Once. A recording is one mounted map for its whole life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleBar]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.getSource<GeoJSONSource>(TRACK_SOURCE)?.setData(lineCollection(track));
  }, [track]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance
      .getSource<GeoJSONSource>(ROUTE_SOURCE)
      ?.setData(lineCollection(route?.coordinates ?? []));
  }, [route]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.getSource<GeoJSONSource>(PROGRESS_SOURCE)?.setData(pointCollection(progressAt));
  }, [progressAt]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current || !position) return;
    instance
      .getSource<GeoJSONSource>(POSITION_SOURCE)
      ?.setData(pointCollection(position, accuracyM));
    if (follow) {
      // `easeTo` rather than `jumpTo`: a dot that teleports every second is unreadable, and
      // a second of easing is shorter than the gap between fixes anyway.
      instance.easeTo({
        center: [position[0], position[1]],
        zoom: Math.max(instance.getZoom(), 15),
        duration: 700,
      });
    }
  }, [position, accuracyM, follow]);

  return (
    <div
      ref={container}
      /*
       * `h-full w-full` is set here rather than left to the caller: `maplibre-gl.css` declares
       * `.maplibregl-map { position: relative }` at the same specificity as Tailwind's
       * `.absolute` and is imported after it, so an `absolute inset-0` container quietly
       * becomes relative with no height, and the map draws into a zero-height box in silence.
       */
      className={`h-full w-full ${className ?? ''}`}
      // A named region, never `aria-hidden`: MapLibre's canvas carries `tabindex="0"` and its
      // zoom controls are real buttons, so hiding it only makes three tab stops that announce
      // nothing. The readout beside it is still where the facts live.
      role="region"
      aria-label="Map of your position and the hike so far"
    />
  );
}

function addRecordLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;

  for (const id of [ROUTE_SOURCE, TRACK_SOURCE, PROGRESS_SOURCE, POSITION_SOURCE]) {
    if (!instance.getSource(id)) {
      instance.addSource(id, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
  }

  // The relief basemap's ground tint is itself a green, so the woodland line is set against the
  // dark casing every drawn line in the product is set against.
  if (!instance.getLayer('rec-route-casing')) {
    instance.addLayer({
      id: 'rec-route-casing',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': CASING, 'line-opacity': 0.55, 'line-width': ROUTE_WIDTH + 3 },
    });
  }

  if (!instance.getLayer('rec-route-line')) {
    instance.addLayer({
      id: 'rec-route-line',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.woodland, 'line-width': ROUTE_WIDTH },
    });
  }

  if (!instance.getLayer('rec-track-casing')) {
    instance.addLayer({
      id: 'rec-track-casing',
      type: 'line',
      source: TRACK_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': CASING, 'line-opacity': 0.7, 'line-width': TRACK_WIDTH + 2 },
    });
  }

  if (!instance.getLayer('rec-track-line')) {
    instance.addLayer({
      id: 'rec-track-line',
      type: 'line',
      source: TRACK_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.contour, 'line-width': TRACK_WIDTH },
    });
  }

  // Hollow, and narrower than the position dot that hides it while the hiker is on route: this
  // is a reading off the trail, not a second claim about where they are.
  if (!instance.getLayer('rec-progress')) {
    instance.addLayer({
      id: 'rec-progress',
      type: 'circle',
      source: PROGRESS_SOURCE,
      paint: {
        'circle-radius': 5,
        'circle-color': CASING,
        'circle-opacity': 0.5,
        'circle-stroke-color': field.woodland,
        'circle-stroke-width': 2,
      },
    });
  }

  // Accuracy first, so the dot sits on top of its own uncertainty rather than under it.
  if (!instance.getLayer('rec-accuracy')) {
    instance.addLayer({
      id: 'rec-accuracy',
      type: 'circle',
      source: POSITION_SOURCE,
      paint: {
        /*
         * Metres converted to screen pixels so the circle means the same thing at every scale.
         * Written as `interpolate` with an exponential base of 2 rather than the arithmetic it
         * plainly is, because MapLibre only accepts `["zoom"]` as the direct input of a
         * top-level `step` or `interpolate` and anything else throws inside `addLayer` — which
         * here takes the whole map down. The 4 px floor keeps a very good fix visible.
         */
        'circle-radius': [
          'interpolate',
          ['exponential', 2],
          ['zoom'],
          0,
          ['max', 4, ['/', ['get', 'accuracyM'], METRES_PER_PIXEL_Z0]],
          22,
          ['max', 4, ['/', ['*', ['get', 'accuracyM'], 2 ** 22], METRES_PER_PIXEL_Z0]],
        ],
        'circle-color': field.survey,
        'circle-opacity': 0.12,
        'circle-stroke-color': field.survey,
        'circle-stroke-opacity': 0.3,
        'circle-stroke-width': 1,
      },
    });
  }

  if (!instance.getLayer('rec-position')) {
    instance.addLayer({
      id: 'rec-position',
      type: 'circle',
      source: POSITION_SOURCE,
      paint: {
        'circle-radius': 7,
        'circle-color': field.survey,
        'circle-stroke-color': field.canvas,
        'circle-stroke-width': 2.5,
      },
    });
  }
}
