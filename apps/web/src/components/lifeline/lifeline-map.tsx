'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { LineString } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';
import { buildStyle } from '../map/basemap';
import { registerRTLText } from '../map/rtl';
import { useScaleBar } from '../map/scale';
import { useUnitsRef } from '../units';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * Where they were, the last time their phone could say.
 *
 * A fourth map, and the smallest one in the product: no viewport reporting, no selection, no
 * follow camera, no track. A follower is not navigating — they are looking at one dot and
 * deciding whether it is where it ought to be. Everything a browse or record map does for a
 * person who is moving would, here, be furniture in the way of that.
 *
 * **It draws one fix, not a history.** A breadcrumb trail would answer questions the hiker
 * did not agree to answer: where they stopped, how long for, whether they went where they
 * said. The link was given so somebody could stop worrying, and the smallest disclosure that
 * does that job is the last known position and the time on it.
 *
 * The dot is survey, the plate this product reserves for you and for safety, ringed in canvas
 * so it holds against shaded ground. When the fix has gone stale the ring stays and the fill
 * hollows out — the page says so in words too, but a dot that looks the same at two minutes
 * and at two hours would be the map quietly disagreeing with the text beside it.
 */

export interface LifelineMapProps {
  /** The hiker's last reported position, or null when the hike is over. */
  at: readonly [number, number] | null;
  /** The trail they said they were on, when they named one. */
  route: LineString | null;
  /** Older than `LIFELINE_STALE_PING_S`. Draws the dot hollow. */
  stale: boolean;
  className?: string;
}

const ROUTE_SOURCE = 'll-route';
const POSITION_SOURCE = 'll-position';

function lineCollection(coords: ReadonlyArray<readonly [number, number]>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      coords.length >= 2
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: coords.map(([lng, lat]) => [lng, lat]) },
            },
          ]
        : [],
  };
}

function pointCollection(at: readonly [number, number] | null): FeatureCollection {
  if (!at) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [at[0], at[1]] } },
    ],
  };
}

export function LifelineMap({ at, route, stale, className }: LifelineMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);

  const scaleBar = useScaleBar(110);
  const units = useUnitsRef();

  useEffect(() => {
    if (!container.current || map.current) return;

    registerRTLText();

    const instance = new maplibregl.Map({
      container: container.current,
      // Relief. The follower's question is "is that a sensible place to be", and shaded
      // ground answers it — a dot in a valley and a dot on a ridge read differently.
      style: buildStyle('relief', { hillshade: true, units: units.current }),
      center: at ? [at[0], at[1]] : [-121.5, 48.0],
      zoom: at ? 13 : 5,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(scaleBar(), 'bottom-left');

    instance.on('load', () => {
      addLifelineLayers(instance, stale);
      instance
        .getSource<maplibregl.GeoJSONSource>(ROUTE_SOURCE)
        ?.setData(lineCollection(route?.coordinates ?? []));
      instance.getSource<maplibregl.GeoJSONSource>(POSITION_SOURCE)?.setData(pointCollection(at));

      /*
       * Frame the trail and the hiker together when both are known. A dot alone at z13 is
       * true but not informative; a dot two thirds of the way along a route the follower
       * recognises is the whole answer. `maxZoom` keeps a short hike from being framed so
       * tightly that the ground around it disappears.
       */
      const coords = [...(route?.coordinates ?? []), ...(at ? [at] : [])];
      if (coords.length >= 2) {
        const bounds = coords.reduce(
          (acc, [lng, lat]) => acc.extend([lng, lat] as [number, number]),
          new maplibregl.LngLatBounds(
            [coords[0]![0], coords[0]![1]],
            [coords[0]![0], coords[0]![1]],
          ),
        );
        instance.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 0 });
      }
    });

    return () => {
      instance.remove();
      map.current = null;
    };
    // Once. The page reloads itself rather than mutating this map, so a fresh fix arrives as
    // a fresh mount with the camera already framed for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleBar]);

  return (
    <div
      ref={container}
      className={className ?? ''}
      // The coordinates, the time on them and how old they are are all printed beside this
      // canvas, which is why this was `aria-hidden`. Hiding it did not remove its tab stops
      // — MapLibre's canvas takes focus and its zoom controls are buttons — so all it bought
      // was focusable content announcing nothing. This page is read by somebody checking
      // whether a hiker is overdue, quite possibly on a phone in a hurry; landing on three
      // silent controls is the last thing it should do. Named region, facts still in text.
      role="region"
      aria-label="Map of the hiker's last known position"
    />
  );
}

function addLifelineLayers(instance: MapLibreMap, stale: boolean): void {
  const field = SCHEMES.field;

  for (const id of [ROUTE_SOURCE, POSITION_SOURCE]) {
    if (!instance.getSource(id)) {
      instance.addSource(id, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
  }

  if (!instance.getLayer('ll-route-line')) {
    instance.addLayer({
      id: 'll-route-line',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.woodland, 'line-width': 4, 'line-opacity': 0.7 },
    });
  }

  // A soft halo under the dot. Not an accuracy radius — we do not store one for a ping, and
  // drawing a circle that means nothing in particular would be worse than drawing none.
  if (!instance.getLayer('ll-halo')) {
    instance.addLayer({
      id: 'll-halo',
      type: 'circle',
      source: POSITION_SOURCE,
      paint: { 'circle-radius': 18, 'circle-color': field.survey, 'circle-opacity': 0.14 },
    });
  }

  if (!instance.getLayer('ll-position')) {
    instance.addLayer({
      id: 'll-position',
      type: 'circle',
      source: POSITION_SOURCE,
      paint: {
        'circle-radius': 8,
        'circle-color': stale ? field.canvas : field.survey,
        'circle-stroke-color': stale ? field.survey : field.canvas,
        'circle-stroke-width': 3,
      },
    });
  }
}
