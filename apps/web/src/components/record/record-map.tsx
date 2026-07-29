'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { LineString } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';
import { buildStyle } from '../map/basemap';
import { registerRTLText } from '../map/rtl';
import { useScaleBar } from '../map/scale';
import { useUnitsRef } from '../units';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * The ground, while you are on it.
 *
 * A third map component, and the third one deliberately. Browse owns a viewport and reports
 * it upward; the trail map is handed a route and shows it; this one **follows a person**. The
 * camera is not the reader's to control by default, the subject moves, and the layer that
 * matters most is a dot that did not exist a second ago. Folding that into either of the
 * others would mean a follow mode, a recording mode and a selection mode inside one file.
 *
 * **Two lines and a dot, in that order of permanence.** The planned route, if there is one,
 * is woodland and sits underneath — it is the trail, drawn the same colour it is drawn
 * everywhere else. The recorded track is contour, the plate this product uses for distance
 * covered. The dot is survey, because survey means you, and on this screen you are the only
 * thing that is a safety fact.
 */

export interface RecordMapProps {
  /** The track so far. Redrawn on every fix, so it stays a plain coordinate array. */
  track: ReadonlyArray<readonly [number, number]>;
  /** The trail being followed, if one was chosen. */
  route: LineString | null;
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
const POSITION_SOURCE = 'rec-position';

/**
 * Ground metres covered by one screen pixel at zoom 0, at 48° north.
 *
 * Web Mercator's scale depends on latitude, and a constant is a lie everywhere except the
 * line it was taken from — 48° is the Cascades, where this was built and tested. The error
 * is a few per cent across the temperate band and grows toward the poles, which is
 * acceptable for a circle whose whole job is to say "somewhere about here": an accuracy
 * halo drawn 5 % small is still an honest picture of a 12 m fix.
 */
const METRES_PER_PIXEL_Z0 = 156_543 * Math.cos((48 * Math.PI) / 180);

/**
 * Where the camera sits before the first fix arrives.
 *
 * A GPS lock outdoors takes seconds and indoors may never come, so this is the view for the
 * part of the hike that happens in a car park — and it has to be worth looking at, because a
 * screen that opens on nothing reads as a screen that is broken.
 *
 * In order of what the hiker can actually use: the position, if the browser has already
 * handed one over; then the trail they chose, framed whole, which answers "am I at the right
 * trailhead"; then a wide view of the region as a last resort. Never a continental zoom —
 * relief tiles at that scale are a grey smear with nothing to recognise in them.
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
              // Copied, not cast. GeoJSON's own types are mutable and MapLibre keeps the
              // array it is handed, so passing the caller's readonly buffer through would
              // be a lie about ownership as well as a type error.
              geometry: { type: 'LineString', coordinates: coords.map(([lng, lat]) => [lng, lat]) },
            },
          ]
        : [],
  };
}

function positionCollection(
  position: readonly [number, number] | null,
  accuracyM: number | null,
): FeatureCollection {
  if (!position) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { accuracyM: accuracyM ?? 0 },
        geometry: { type: 'Point', coordinates: [position[0], position[1]] },
      },
    ],
  };
}

export function RecordMap({
  track,
  route,
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

  /*
   * The current data, kept somewhere the `load` handler can reach it.
   *
   * The three effects below write to sources that do not exist until `load` fires, so each
   * one guards on `ready` and returns early on the first pass. For `position` that is
   * harmless — fixes keep arriving, and the next one lands after the map is up. For `route`
   * it is fatal: the chosen trail is passed once and never changes identity again, so the
   * effect that draws it runs exactly once, before there is anything to draw into, and the
   * line is silently never added. Seeding from the load handler closes that window without
   * making the effects re-run.
   */
  const latest = useRef({ track, route, position, accuracyM });
  latest.current = { track, route, position, accuracyM };

  const scaleBar = useScaleBar(110);
  const units = useUnitsRef();

  useEffect(() => {
    if (!container.current || map.current) return;

    registerRTLText();

    const instance = new maplibregl.Map({
      container: container.current,
      // Relief, always. The switcher belongs on a screen where you are choosing a hike; on
      // this one the only question is where you are, and shaded ground answers it in the
      // dark without a network round trip for imagery.
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

      // Whatever arrived while the style was loading. Without this the trail line never
      // draws at all — see the note on `latest` above.
      const now = latest.current;
      instance.getSource<GeoJSONSource>(TRACK_SOURCE)?.setData(lineCollection(now.track));
      instance
        .getSource<GeoJSONSource>(ROUTE_SOURCE)
        ?.setData(lineCollection(now.route?.coordinates ?? []));
      if (now.position) {
        instance
          .getSource<GeoJSONSource>(POSITION_SOURCE)
          ?.setData(positionCollection(now.position, now.accuracyM));
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
    if (!instance || !ready.current || !position) return;
    instance
      .getSource<GeoJSONSource>(POSITION_SOURCE)
      ?.setData(positionCollection(position, accuracyM));
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
       * `h-full w-full` is set here rather than left to the caller, and it is not belt and
       * braces. `maplibre-gl.css` declares `.maplibregl-map { position: relative }` at the
       * same specificity as Tailwind's `.absolute` and is imported after it, so a container
       * positioned with `absolute inset-0` quietly becomes `relative` with no height at all —
       * a map that mounts, loads its style, fetches its tiles, reports a sane viewport to
       * every effect here, and draws into a zero-height box. Nothing throws and nothing logs.
       * Sizing the element itself is the only version of this that cannot be got wrong from
       * outside, which matters more here than elsewhere: this is the map somebody is reading
       * to find out where they are.
       */
      className={`h-full w-full ${className ?? ''}`}
      // Every number this canvas encodes is printed in the readout beside it, at a size that
      // can be read at arm's length — but that is an argument for keeping this quiet, not for
      // `aria-hidden`, which is what it used to be. Hiding an element does not un-focus it:
      // MapLibre's canvas carries `tabindex="0"` and its zoom controls are real buttons, so
      // the only thing that achieved was three tab stops that announced nothing. On this page
      // of all of them — somebody mid-hike, working out where they are — that is the wrong
      // failure to ship. Named region instead; the readout is still where the facts live.
      role="region"
      aria-label="Map of your position and the hike so far"
    />
  );
}

function addRecordLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;

  for (const id of [ROUTE_SOURCE, TRACK_SOURCE, POSITION_SOURCE]) {
    if (!instance.getSource(id)) {
      instance.addSource(id, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
  }

  /*
   * The planned route gets a casing, the same as the track does.
   *
   * It used to be a bare 6 px woodland line at 0.55 opacity, on the reasoning that the plan
   * should sit quieter than what you have actually hiked. Right instinct, wrong instrument:
   * the relief basemap's ground tint is itself a green (`#4F6B3B`), so washing a green line
   * out over it left the trail barely findable — and before the first fix arrives, that line
   * is the *only* thing on this screen. It is what answers "am I at the right trailhead".
   *
   * So the hierarchy is carried by hue and width instead, which survive any background: the
   * route is woodland and thin, the track is contour and reads hot against it. Both get the
   * same dark casing, which is what makes either legible on ground of any colour.
   */
  if (!instance.getLayer('rec-route-casing')) {
    instance.addLayer({
      id: 'rec-route-casing',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0B1214', 'line-opacity': 0.55, 'line-width': 8 },
    });
  }

  if (!instance.getLayer('rec-route-line')) {
    instance.addLayer({
      id: 'rec-route-line',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': field.woodland,
        'line-width': 5,
        'line-opacity': 0.9,
      },
    });
  }

  if (!instance.getLayer('rec-track-casing')) {
    instance.addLayer({
      id: 'rec-track-casing',
      type: 'line',
      source: TRACK_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0B1214', 'line-opacity': 0.7, 'line-width': 8 },
    });
  }

  if (!instance.getLayer('rec-track-line')) {
    instance.addLayer({
      id: 'rec-track-line',
      type: 'line',
      source: TRACK_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.contour, 'line-width': 4 },
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
         * Metres converted to screen pixels, so the circle means the same thing at every
         * scale. A pixel is 156543·cos(lat)/2^z metres, so the radius doubles with each zoom
         * level — which has to be written as `interpolate` with an exponential base of 2
         * rather than as the arithmetic it plainly is. MapLibre only accepts `["zoom"]` as
         * the direct input of a top-level `step` or `interpolate`; anything else throws
         * inside `addLayer`, and because these layers are added in one pass, one bad
         * expression takes the whole map down with it.
         *
         * The two stops are exact rather than approximate: interpolating exponentially from
         * r to r·2²² across z0–z22 reproduces r·2^z at every level in between. The 4 px
         * floor keeps a very good fix from vanishing under its own dot.
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
