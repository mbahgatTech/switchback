'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { BBox, RouteAnchor, RoutePlan } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';
import { type BasemapId, buildStyle } from '../map/basemap';
import { registerRTLText } from '../map/rtl';
import { useScaleBar } from '../map/scale';
import { useUnits } from '../units';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * The drawing surface — the one map in this product the reader writes to, so a stray gesture
 * here destroys work and most of what is below exists to stop that.
 *
 * The planned route is woodland; every leg the router could *not* follow is redrawn over it as
 * a dashed survey line, which is why `RouteLeg` carries its own endpoints — the planned
 * geometry is simplified to 5 m, so slicing it back into legs by cumulative distance drifts.
 *
 * Anchors are DOM markers rather than a symbol layer, which gets dragging, hit-testing and
 * hover styling free. The cost is that a click on a pin bubbles to the canvas and MapLibre
 * raises it as a map click, so every pin stops its own click and a drag arms `dragged`.
 */

export interface PlanMapProps {
  anchors: readonly RouteAnchor[];
  plan: RoutePlan | null;
  basemap: BasemapId;
  hillshade: boolean;
  onAddAnchor: (lng: number, lat: number) => void;
  onMoveAnchor: (index: number, lng: number, lat: number) => void;
  onRemoveAnchor: (index: number) => void;
  /**
   * Where the map settled, so the routing tiles under it can start downloading before the
   * reader has clicked anything — the difference between a first route that snaps and one
   * that comes back as a straight line.
   */
  onViewportChange?: (bbox: BBox) => void;
  /** Where the section's cursor currently sits on the ground. Same dot as a trail page's. */
  cursor: readonly [number, number] | null;
  initialCenter: readonly [number, number];
  initialZoom: number;
  /**
   * An explicit "look here" request. A nonce rather than the box alone, so asking twice for the
   * same ground moves the camera twice.
   */
  frame?: { bbox: BBox; nonce: number } | null;
}

const ROUTE_SOURCE = 'plan-route';
const STRAIGHT_SOURCE = 'plan-straight';
const DRAFT_SOURCE = 'plan-draft';
const CURSOR_SOURCE = 'plan-cursor';

/** Empty until the first plan lands. */
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function routeCollection(plan: RoutePlan | null): FeatureCollection {
  const coords = plan?.geometry?.coordinates ?? [];
  if (coords.length < 2) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        // Copied rather than passed through: MapLibre keeps the array it is given, and these
        // coordinates belong to React state that will be replaced on the next plan.
        geometry: { type: 'LineString', coordinates: coords.map(([lng, lat]) => [lng, lat]) },
      },
    ],
  };
}

/** Every leg the router could not follow, as its own two-point line. */
function straightCollection(plan: RoutePlan | null): FeatureCollection {
  const legs = (plan?.legs ?? []).filter((leg) => !leg.snapped);
  if (legs.length === 0) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: legs.map((leg) => ({
      type: 'Feature',
      properties: { to: leg.to, reason: leg.reason ?? 'freehand' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [leg.start[0], leg.start[1]],
          [leg.end[0], leg.end[1]],
        ],
      },
    })),
  };
}

/**
 * The points joined in order, drawn only while there is no plan to draw instead: the first plan
 * over cold ground takes a second or two, and two pins with nothing between them read as a map
 * that did not understand the second click.
 */
function draftCollection(
  anchors: readonly RouteAnchor[],
  plan: RoutePlan | null,
): FeatureCollection {
  if (plan?.geometry || anchors.length < 2) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: anchors.map((anchor) => [anchor.lng, anchor.lat]),
        },
      },
    ],
  };
}

function cursorCollection(cursor: readonly [number, number] | null): FeatureCollection {
  if (!cursor) return EMPTY;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [cursor[0], cursor[1]] },
      },
    ],
  };
}

/**
 * One numbered pin. A button, so it gets the cursor, the press state and a real tap for free.
 * Out of the tab order and hidden from assistive technology on purpose: the collar beside this
 * map lists the same points as named buttons, and sixty pins labelled "3" is not content.
 */
function pinElement(): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className =
    'flex h-6 w-6 cursor-grab items-center justify-center rounded-pill border-2 font-mono text-micro leading-none tracking-normal tabular-nums active:cursor-grabbing';
  element.tabIndex = -1;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/** Colour a pin by its place in the line: start, finish, or somewhere in between. */
function paintPin(element: HTMLElement, index: number, total: number): void {
  const start = index === 0;
  const finish = index === total - 1 && total > 1;
  element.classList.remove(
    'border-woodland',
    'bg-woodland',
    'border-ink',
    'bg-ink',
    'bg-surface',
    'text-canvas',
    'text-ink',
  );
  if (start) {
    element.classList.add('border-woodland', 'bg-woodland', 'text-canvas');
  } else if (finish) {
    element.classList.add('border-ink', 'bg-ink', 'text-canvas');
  } else {
    element.classList.add('border-ink', 'bg-surface', 'text-ink');
  }
  element.textContent = String(index + 1);
  element.title =
    total > 1
      ? `Point ${String(index + 1)} of ${String(total)} — drag to move, click to remove`
      : 'Start — drag to move, click to remove';
}

export function PlanMap({
  anchors,
  plan,
  basemap,
  hillshade,
  onAddAnchor,
  onMoveAnchor,
  onRemoveAnchor,
  onViewportChange,
  cursor,
  initialCenter,
  initialZoom,
  frame = null,
}: PlanMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const markers = useRef<maplibregl.Marker[]>([]);

  /*
   * The callbacks change identity on every render of the planner, and the listeners below are
   * registered once. They read through this box, which always holds the current set.
   */
  const handlers = useRef({ onAddAnchor, onMoveAnchor, onRemoveAnchor, onViewportChange });
  handlers.current = { onAddAnchor, onMoveAnchor, onRemoveAnchor, onViewportChange };

  /*
   * Armed by a drag, disarmed on the next tick. A marker drag ends with `mouseup` and the
   * browser fires `click` straight after, so without this every drag would also delete its
   * point. Cleared on a zero-delay timer rather than in the click handler, which keeps the
   * guard correct when a drag ends outside the pin and no click follows.
   */
  const dragged = useRef(false);

  // The current data, reachable from the `load` handler. The sources it writes into do not
  // exist until the style is up, so a plan that arrives first would otherwise never be drawn.
  const latest = useRef({ anchors, plan, cursor });
  latest.current = { anchors, plan, cursor };

  const scaleBar = useScaleBar(120);
  const units = useUnits();

  useEffect(() => {
    if (!container.current || map.current) return;

    registerRTLText();

    const instance = new maplibregl.Map({
      container: container.current,
      style: buildStyle(basemap, { hillshade, units }),
      center: [initialCenter[0], initialCenter[1]],
      zoom: initialZoom,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(scaleBar(), 'bottom-left');

    // A crosshair says "this surface takes marks". The grab hand MapLibre uses by default says
    // the opposite, and on a screen whose whole purpose is drawing that is the wrong promise.
    instance.getCanvas().style.cursor = 'crosshair';

    instance.on('click', (event) => {
      handlers.current.onAddAnchor(event.lngLat.lng, event.lngLat.lat);
    });

    /*
     * Report the view once it stops moving. `moveend` rather than `move`: each intermediate
     * frame of a drag would be another tile-coverage check. `fitBounds` raises it too, so
     * opening a saved route reports its own extent.
     */
    const report = (): void => {
      const bounds = instance.getBounds();
      handlers.current.onViewportChange?.([
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ]);
    };
    instance.on('moveend', report);

    instance.on('load', () => {
      ready.current = true;
      addPlanLayers(instance);
      const now = latest.current;
      instance.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(routeCollection(now.plan));
      instance.getSource<GeoJSONSource>(STRAIGHT_SOURCE)?.setData(straightCollection(now.plan));
      instance
        .getSource<GeoJSONSource>(DRAFT_SOURCE)
        ?.setData(draftCollection(now.anchors, now.plan));
      instance.getSource<GeoJSONSource>(CURSOR_SOURCE)?.setData(cursorCollection(now.cursor));
      report();
    });

    return () => {
      for (const marker of markers.current) marker.remove();
      markers.current = [];
      instance.remove();
      map.current = null;
      ready.current = false;
    };
    // Once. Camera and base map changes are handled by the effects below; re-running this
    // would tear the map down mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleBar]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(routeCollection(plan));
    instance.getSource<GeoJSONSource>(STRAIGHT_SOURCE)?.setData(straightCollection(plan));
    instance.getSource<GeoJSONSource>(DRAFT_SOURCE)?.setData(draftCollection(anchors, plan));
  }, [plan, anchors]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.getSource<GeoJSONSource>(CURSOR_SOURCE)?.setData(cursorCollection(cursor));
  }, [cursor]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    /*
     * Reconciled in place rather than rebuilt. Marker `i` always represents anchor `i`, and
     * removing and re-adding the element the pointer is holding cancels the drag in progress —
     * which is exactly when this effect runs, because the drag is what changed the anchor.
     */
    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index]!;
      let marker = markers.current[index];

      if (!marker) {
        const element = pinElement();
        element.addEventListener('click', (event) => {
          // Without this the click reaches the canvas container, where MapLibre raises it as a
          // map click and the planner adds a point exactly where one was just removed.
          event.stopPropagation();
          if (dragged.current) return;
          handlers.current.onRemoveAnchor(index);
        });

        const created = new maplibregl.Marker({ element, draggable: true });
        created.on('dragstart', () => {
          dragged.current = true;
        });
        created.on('dragend', () => {
          const { lng, lat } = created.getLngLat();
          handlers.current.onMoveAnchor(index, lng, lat);
          // See `dragged`: the click the browser is about to fire belongs to this drag.
          setTimeout(() => {
            dragged.current = false;
          }, 0);
        });
        created.setLngLat([anchor.lng, anchor.lat]).addTo(instance);
        marker = created;
        markers.current[index] = created;
      } else {
        marker.setLngLat([anchor.lng, anchor.lat]);
      }

      paintPin(marker.getElement(), index, anchors.length);
    }

    for (const extra of markers.current.splice(anchors.length)) extra.remove();
  }, [anchors]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !frame) return;
    const [west, south, east, north] = frame.bbox;
    instance.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      {
        padding: { top: 64, bottom: 64, left: 64, right: 64 },
        maxZoom: 15,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 620,
      },
    );
    // The nonce is the event; the box is read, not watched. See `frame`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.nonce]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    // `setStyle` drops every source and layer we added, so they go back on once the new base
    // has loaded. `styledata` rather than `load`, which fired long ago.
    const restore = () => {
      addPlanLayers(instance);
      const now = latest.current;
      instance.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(routeCollection(now.plan));
      instance.getSource<GeoJSONSource>(STRAIGHT_SOURCE)?.setData(straightCollection(now.plan));
      instance
        .getSource<GeoJSONSource>(DRAFT_SOURCE)
        ?.setData(draftCollection(now.anchors, now.plan));
      instance.getSource<GeoJSONSource>(CURSOR_SOURCE)?.setData(cursorCollection(now.cursor));
      instance.getCanvas().style.cursor = 'crosshair';
    };
    instance.setStyle(buildStyle(basemap, { hillshade, units }));
    void instance.once('styledata', restore);
  }, [basemap, hillshade, units]);

  return (
    <div
      ref={container}
      // Sized here, never positioned. `maplibre-gl.css` sets `.maplibregl-map { position:
      // relative }` at the same specificity as Tailwind's `.absolute` and is imported after it,
      // so an `absolute inset-0` container silently collapses to zero height.
      className="h-full w-full"
      // Labelled rather than hidden: MapLibre gives its canvas `tabindex="0"`, and `aria-hidden`
      // over a focusable element leaves a tab stop announcing nothing.
      role="region"
      aria-label="Route drawing map"
    />
  );
}

function addPlanLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;

  for (const id of [DRAFT_SOURCE, ROUTE_SOURCE, STRAIGHT_SOURCE, CURSOR_SOURCE]) {
    if (!instance.getSource(id)) {
      instance.addSource(id, { type: 'geojson', data: EMPTY });
    }
  }

  if (!instance.getLayer('plan-draft-line')) {
    instance.addLayer({
      id: 'plan-draft-line',
      type: 'line',
      source: DRAFT_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': field.inkMuted,
        'line-width': 2,
        'line-opacity': 0.7,
        'line-dasharray': [1, 2],
      },
    });
  }

  // The casing is what makes a green line readable over relief, whose ground tint is itself
  // a green. Without it the route is findable on rock and invisible in forest.
  if (!instance.getLayer('plan-route-casing')) {
    instance.addLayer({
      id: 'plan-route-casing',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0B1214', 'line-opacity': 0.7, 'line-width': 9 },
    });
  }

  if (!instance.getLayer('plan-route-line')) {
    instance.addLayer({
      id: 'plan-route-line',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.woodland, 'line-width': 5 },
    });
  }

  /*
   * The unroutable stretches, drawn over the line that already contains them. Dashed, in
   * survey, at the route's own width rather than thinner: this is not an annotation on the
   * route, it is a statement that this part of it is not a path.
   */
  if (!instance.getLayer('plan-straight-line')) {
    instance.addLayer({
      id: 'plan-straight-line',
      type: 'line',
      source: STRAIGHT_SOURCE,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': field.survey,
        'line-width': 5,
        'line-dasharray': [1.6, 1.2],
      },
    });
  }

  // The same dot, size and ring as the cursor on a trail page's map.
  if (!instance.getLayer('plan-cursor-dot')) {
    instance.addLayer({
      id: 'plan-cursor-dot',
      type: 'circle',
      source: CURSOR_SOURCE,
      paint: {
        'circle-radius': 6,
        'circle-color': field.ink,
        'circle-stroke-color': field.canvas,
        'circle-stroke-width': 2,
      },
    });
  }
}
