'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { Protocol } from 'pmtiles';
import type { BBox, LineString, Waypoint, WaypointKind } from '@switchback/core';
import {
  FLYOVER_PITCH,
  type FlyoverPlan,
  flyoverOverview,
  flyoverZoom,
  poseAt,
} from '@switchback/geo';
import { SCHEMES } from '@switchback/ui';
import {
  type BasemapId,
  TERRAIN_EXAGGERATION,
  TERRAIN_PITCH,
  buildStyle,
  pmtilesUrl,
} from '../map/basemap';
import { prefersReducedMotion } from '../map/motion';
import { registerSlopeProtocol } from '../map/slope-protocol';
import { registerRTLText } from '../map/rtl';
import { useScaleBar } from '../map/scale';
import { useUnits } from '../units';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * One trail, drawn on the ground. A different component from the browse map rather than a mode
 * of it: this one owns no viewport, only the camera during a flyover — sixty `jumpTo` calls a
 * second would be sixty React renders if the pose were a prop.
 */

export interface RouteMapProps {
  geometry: LineString;
  bbox: BBox;
  waypoints: readonly Waypoint[];
  /** Where the reader is pointing on the section, projected onto the ground. */
  cursor: [number, number] | null;
  basemap: BasemapId;
  hillshade: boolean;
  /** Avalanche-convention slope shading over the DEM. Off by default; see `map/slope`. */
  slope: boolean;
  /** Render the ground as a mesh and let the reader tilt and spin it. */
  terrain: boolean;
  /** Non-null while the route is being flown; the plan carries its own duration and pacing. */
  flyover?: FlyoverPlan | null;
  /**
   * Called every frame with how far along the route the camera is, and once with `null` when
   * the flight ends. The section's cursor is driven from it.
   */
  onFlyoverTick?: (distanceM: number | null) => void;
  /** Called once when the film reaches its end of its own accord, so the control can reset. */
  onFlyoverEnd?: () => void;
  /** Reported after every gesture settles, not during one. The slope key is the only reader. */
  onZoomChange?: (zoom: number) => void;
  className?: string;
}

const ROUTE_SOURCE = 'route';
const POINT_SOURCE = 'route-points';
const CURSOR_SOURCE = 'route-cursor';

/**
 * Which plate a waypoint prints on. `hazard` alone takes survey, which means safety and
 * nothing else; water features take water, high ground contour, anything built by people ink.
 */
const WAYPOINT_PLATE: Record<WaypointKind, 'survey' | 'water' | 'contour' | 'woodland' | 'ink'> = {
  trailhead: 'woodland',
  summit: 'contour',
  viewpoint: 'contour',
  water: 'water',
  waterfall: 'water',
  lake: 'water',
  ford: 'water',
  parking: 'ink',
  toilets: 'ink',
  shelter: 'ink',
  campsite: 'ink',
  junction: 'ink',
  gate: 'ink',
  hazard: 'survey',
};

/** Kinds worth a label at any zoom. The rest label only when the map is already close in. */
const NAMED_KINDS: readonly WaypointKind[] = ['summit', 'trailhead', 'hazard', 'shelter'];

function routeCollection(geometry: LineString): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry }],
  };
}

function pointCollection(waypoints: readonly Waypoint[], geometry: LineString): FeatureCollection {
  const ends = geometry.coordinates;
  const first = ends[0];
  const last = ends[ends.length - 1];

  const features: FeatureCollection['features'] = waypoints.map((waypoint) => ({
    type: 'Feature',
    properties: {
      plate: WAYPOINT_PLATE[waypoint.kind],
      label: waypoint.name ?? kindLabel(waypoint.kind),
      // Priority, not importance: it decides which label MapLibre drops when two collide.
      priority: NAMED_KINDS.includes(waypoint.kind) ? 1 : 0,
    },
    geometry: { type: 'Point', coordinates: [waypoint.lng, waypoint.lat] },
  }));

  // The two ends are always marked even when OSM has no trailhead node: a route with no start
  // cannot be read for direction, and every stat on the page is measured from one end of it.
  if (first && last) {
    features.push(
      {
        type: 'Feature',
        properties: { plate: 'woodland', label: 'Start', priority: 1 },
        geometry: { type: 'Point', coordinates: first },
      },
      {
        type: 'Feature',
        properties: { plate: 'ink', label: 'Finish', priority: 1 },
        geometry: { type: 'Point', coordinates: last },
      },
    );
  }

  return { type: 'FeatureCollection', features };
}

function kindLabel(kind: WaypointKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ');
}

function cursorCollection(cursor: [number, number] | null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cursor
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: cursor } }]
      : [],
  };
}

export function RouteMap({
  geometry,
  bbox,
  waypoints,
  cursor,
  basemap,
  hillshade,
  slope,
  terrain,
  flyover = null,
  onFlyoverTick,
  onFlyoverEnd,
  onZoomChange,
  className,
}: RouteMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);

  // The map closes over its first render, so callbacks and the framing are read back through
  // refs. In the effect's deps they would tear the map down on every parent re-render.
  const report = useRef(onZoomChange);
  const tick = useRef(onFlyoverTick);
  const ended = useRef(onFlyoverEnd);
  const framing = useRef(bbox);
  const pitched = useRef(terrain);
  useEffect(() => {
    report.current = onZoomChange;
    tick.current = onFlyoverTick;
    ended.current = onFlyoverEnd;
    framing.current = bbox;
    pitched.current = terrain;
  }, [onZoomChange, onFlyoverTick, onFlyoverEnd, bbox, terrain]);

  const scaleBar = useScaleBar(110);
  const units = useUnits();

  useEffect(() => {
    if (!container.current || map.current) return;

    let protocol: Protocol | null = null;
    if (pmtilesUrl()) {
      protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    }

    // Unconditional and never removed: a `slope://` source in a style that arrives before the
    // protocol does is a tile error rather than a retry.
    registerSlopeProtocol();

    // Same reason: a right-to-left summit name drawn before the shaper loads is drawn
    // backwards. See `map/rtl`.
    registerRTLText();

    const [w, s, e, n] = bbox;
    const instance = new maplibregl.Map({
      container: container.current,
      style: buildStyle(basemap, { hillshade, slope, terrain, units }),
      // Framed on the trail from the first paint. Opening on a centre and then flying to
      // the route would animate a map the reader did not ask to move.
      bounds: [
        [w, s],
        [e, n],
      ],
      fitBoundsOptions: { padding: 48, maxZoom: 15 },
      // Rotation and pitch start disabled and are switched on with terrain below.
      // `pitchWithRotate` is deliberately left at its default: it can only be set at
      // construction, so turning it off would permanently cost the right-drag its tilt.
      // `maxPitch` is construction-only too, and a flyover past MapLibre's default 60 would
      // be silently clamped with the horizon never coming into frame.
      dragRotate: false,
      maxPitch: 80,
      attributionControl: false,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(scaleBar(), 'bottom-left');

    instance.on('load', () => {
      ready.current = true;
      addRouteLayers(instance);
      instance.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(routeCollection(geometry));
      instance
        .getSource<GeoJSONSource>(POINT_SOURCE)
        ?.setData(pointCollection(waypoints, geometry));
      // The opening zoom is whatever `fitBounds` chose for this trail, which on a long route
      // is far enough out that the slope layer cannot draw. The key needs that up front.
      report.current?.(instance.getZoom());
    });

    instance.on('moveend', () => report.current?.(instance.getZoom()));

    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
      if (protocol) maplibregl.removeProtocol('pmtiles');
    };
    // Once. The trail does not change under a mounted map — a different trail is a
    // different route, so Next unmounts this along with the rest of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleBar]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.setStyle(buildStyle(basemap, { hillshade, slope, terrain, units }));
    void instance.once('styledata', () => {
      addRouteLayers(instance);
      instance.getSource<GeoJSONSource>(ROUTE_SOURCE)?.setData(routeCollection(geometry));
      instance
        .getSource<GeoJSONSource>(POINT_SOURCE)
        ?.setData(pointCollection(waypoints, geometry));
      instance.getSource<GeoJSONSource>(CURSOR_SOURCE)?.setData(cursorCollection(cursor));
    });
    // The route and cursor are read on restore but must not trigger a style rebuild; the
    // cursor effect below runs many times a second and would thrash the whole base map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, hillshade, slope, terrain, units]);

  /*
   * Where the ground is under the middle of the frame. MapLibre's own `getCenterElevation`
   * reads 0 over a route at 2,400 m: its terrain lookup starts a level below what our
   * `tileSize: 256` terrarium source caches, finds nothing, and returns zero rather than null.
   * A camera aimed underground hits the mesh far too near, and the route climbs out of frame.
   * `queryTerrainElevation` derives its own zoom from the loaded tiles and answers correctly,
   * so the clamp is off and the centre elevation is set from that on `moveend` and `idle`.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !terrain || flyover) return;

    instance.setCenterClampedToGround(false);

    const sync = () => {
      // `setCenterElevation` is a `jumpTo`, which fires the events that call this; a metre of
      // slack stops two floats chasing each other.
      if (instance.isMoving()) return;
      const ground = instance.queryTerrainElevation(instance.getCenter());
      if (ground !== null && Math.abs(instance.getCenterElevation() - ground) > 1) {
        instance.setCenterElevation(ground);
      }
    };

    sync();
    instance.on('moveend', sync);
    instance.on('idle', sync);

    return () => {
      instance.off('moveend', sync);
      instance.off('idle', sync);
      instance.setCenterClampedToGround(true);
    };
  }, [terrain, flyover]);

  /*
   * Rotation and pitch follow terrain: without them a mesh is a picture of a mesh. Both edges
   * re-frame on the trail's own bounds so the transition reads as "same map, tilted" — but
   * only from flat, so a reader who set their own angle keeps it, and never mid-flight, where
   * the animation loop owns the camera.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    const reframe = (pitch: number) => {
      if (!ready.current || flyover) return;
      const [w, s, e, n] = framing.current;
      instance.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        {
          padding: 48,
          maxZoom: 15,
          bearing: 0,
          pitch,
          duration: prefersReducedMotion() ? 0 : 700,
        },
      );
    };

    if (terrain) {
      instance.dragRotate.enable();
      instance.touchZoomRotate.enableRotation();
      instance.touchPitch.enable();
      instance.keyboard.enableRotation();
      if (instance.getPitch() === 0) reframe(TERRAIN_PITCH);
      return;
    }

    instance.dragRotate.disable();
    instance.touchZoomRotate.disableRotation();
    instance.touchPitch.disable();
    instance.keyboard.disableRotation();
    if (instance.getPitch() !== 0 || instance.getBearing() !== 0) reframe(0);
  }, [terrain, flyover]);

  /*
   * The flyover: one `requestAnimationFrame` loop, one `jumpTo` per frame, no React state in
   * the middle. `jumpTo` rather than `easeTo` because the pose already carries Tobler's pacing,
   * and smoothing between two poses 16 ms apart would flatten the labouring on the climb.
   * The loop waits for `idle`, since pressing play usually rebuilds the style in the same commit.
   */
  useEffect(() => {
    if (!flyover) return;
    const instance = map.current;
    if (!instance || !ready.current) return;

    let frame = 0;
    let cancelled = false;

    /*
     * The camera is told how high the ground is rather than left to find out: the same broken
     * lookup as above, plus a flyover outrunning DEM tile loads. Placed two kilometres inside
     * the mountain, back-face culling renders an empty frame with no error at all. Every pose
     * carries `eleM` from our own ingest pass, and `jumpTo` prefers an explicit `elevation`.
     */
    const clamped = instance.getCenterClampedToGround();
    instance.setCenterClampedToGround(false);
    /** Metres above sea level as MapLibre counts them, which is to say pre-multiplied. */
    const meshEleM = (eleM: number) => (pitched.current ? eleM * TERRAIN_EXAGGERATION : 0);

    const restore = () => {
      const current = map.current;
      tick.current?.(null);
      if (!current) return;
      const [w, s, e, n] = framing.current;
      current.stop();
      current.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        {
          padding: 48,
          maxZoom: 15,
          bearing: 0,
          // Back to the framing the page opened on, but not back to flat if the ground is
          // still switched on — the film ending is not the reader asking for a plan view.
          pitch: pitched.current ? TERRAIN_PITCH : 0,
          duration: prefersReducedMotion() ? 0 : 800,
        },
      );
    };

    const still = () => {
      // No animation for a reader who has asked for none. What survives being still is the
      // arrangement of the ground: the whole route in frame, tilted, seen from the high point.
      const pose = flyoverOverview(flyover);
      if (!pose) return;
      const [w, s, e, n] = framing.current;
      instance.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 64, maxZoom: 15, bearing: pose.bearing, pitch: FLYOVER_PITCH, duration: 0 },
      );
      // After the framing, not before: `fitBounds` is a `jumpTo` with no elevation of its own,
      // and under terrain that means it overwrites this with the zero the broken lookup returns.
      instance.setCenterElevation(meshEleM(pose.eleM));
      // The section marks the summit, so the still has a reading to go with it.
      tick.current?.(pose.distanceM);
    };

    const fly = () => {
      const box = instance.getContainer();
      const zoom = flyoverZoom(
        flyover,
        { width: box.clientWidth, height: box.clientHeight },
        // The mesh is drawn at this multiple of the profile's real metres, and it is the mesh
        // the camera has to clear.
        { exaggeration: pitched.current ? TERRAIN_EXAGGERATION : 1 },
      );
      let startedAt = 0;

      const step = (now: number) => {
        if (startedAt === 0) startedAt = now;
        const progress = (now - startedAt) / flyover.durationMs;
        const pose = poseAt(flyover, progress);
        if (pose) {
          instance.jumpTo({
            center: pose.center,
            bearing: pose.bearing,
            pitch: FLYOVER_PITCH,
            zoom,
            elevation: meshEleM(pose.eleM),
          });
          tick.current?.(pose.distanceM);
        }
        if (progress >= 1) {
          // Ending is the parent's business: setting `flyover` to null runs the cleanup below.
          ended.current?.();
          return;
        }
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    const begin = () => {
      if (cancelled) return;
      if (prefersReducedMotion()) still();
      else fly();
    };

    if (instance.isStyleLoaded()) begin();
    else void instance.once('idle', begin);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      // Hand the centre point back to the terrain before re-framing, so the map tracks the
      // ground under it again the moment the reader pans.
      instance.setCenterClampedToGround(clamped);
      restore();
    };
  }, [flyover]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.getSource<GeoJSONSource>(CURSOR_SOURCE)?.setData(cursorCollection(cursor));
  }, [cursor]);

  return (
    <div
      ref={container}
      className={className ?? ''}
      // Labelled, not hidden. `aria-hidden` removes an element from the accessibility tree but
      // not from the tab order, and MapLibre puts `tabindex="0"` on its canvas and ships real
      // zoom buttons — three tab stops with nothing to say, WCAG 4.1.2. `region` rather than
      // `application`: the arrow keys pan a view, they do not drive a widget, and `application`
      // would switch off the reading-mode keys used to skip past it.
      role="region"
      aria-label="Map of the trail route"
    />
  );
}

/**
 * The route, its waypoints and the cursor — bottom to top. Drawn thicker than on the browse
 * map, where the line is one of sixty rather than the subject.
 */
function addRouteLayers(instance: MapLibreMap): void {
  const field = SCHEMES.field;

  for (const id of [ROUTE_SOURCE, POINT_SOURCE, CURSOR_SOURCE]) {
    if (!instance.getSource(id)) {
      instance.addSource(id, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
  }

  if (!instance.getLayer('route-casing')) {
    instance.addLayer({
      id: 'route-casing',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0B1214', 'line-opacity': 0.6, 'line-width': 9 },
    });
  }

  if (!instance.getLayer('route-line')) {
    instance.addLayer({
      id: 'route-line',
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': field.woodland, 'line-width': 4 },
    });
  }

  const plateColor = [
    'match',
    ['get', 'plate'],
    'survey',
    field.survey,
    'water',
    field.water,
    'contour',
    field.contour,
    'woodland',
    field.woodland,
    field.ink,
  ] as unknown as maplibregl.ExpressionSpecification;

  if (!instance.getLayer('route-waypoints')) {
    instance.addLayer({
      id: 'route-waypoints',
      type: 'circle',
      source: POINT_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 15, 6],
        'circle-color': plateColor,
        // The same dark casing the line carries, for the same reason: these sit on ground
        // whose colour we do not control.
        'circle-stroke-color': '#0B1214',
        'circle-stroke-width': 1.5,
      },
    });
  }

  if (!instance.getLayer('route-waypoint-labels')) {
    instance.addLayer({
      id: 'route-waypoint-labels',
      type: 'symbol',
      source: POINT_SOURCE,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-letter-spacing': 0.04,
        // Sorted so that when two labels collide the summit survives and the gate does not.
        'symbol-sort-key': ['-', 0, ['get', 'priority']],
        // Without a glyph endpoint there are no fonts to shape with, so labels are asked
        // for only on the vector base, which brings its own.
        'text-optional': true,
        'text-font': ['Noto Sans Regular'],
      },
      paint: {
        'text-color': field.ink,
        'text-halo-color': '#0B1214',
        'text-halo-width': 1.4,
      },
    });
  }

  if (!instance.getLayer('route-cursor')) {
    instance.addLayer({
      id: 'route-cursor',
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
