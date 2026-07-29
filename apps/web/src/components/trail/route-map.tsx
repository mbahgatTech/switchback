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
 * One trail, drawn on the ground.
 *
 * Deliberately a different component from the browse map rather than a mode of it. Browse
 * owns a viewport and reports it upward; this one owns nothing — it is handed a route and a
 * cursor and shows them. Sharing a component would mean a viewport-reporting debounce, a
 * hover state and a selection state living inside a screen that has exactly one trail and
 * no selection to make.
 *
 * The cursor dot is the same ink, the same size and the same canvas ring as the dot on the
 * section beside it. That is the entire point of the pairing: the reader should recognise
 * one mark in two places rather than learn two marks.
 *
 * The one thing it does own is the camera during a flyover. The plan comes from `geo` and the
 * play state from the parent, but the frame loop lives here, because sixty `jumpTo` calls a
 * second are sixty React renders if the pose is a prop — and the parent would be re-rendering
 * an elevation section on every one of them.
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
  /**
   * Non-null while the route is being flown. The plan carries its own duration and pacing;
   * this component supplies only the clock and the projection.
   */
  flyover?: FlyoverPlan | null;
  /**
   * Called every frame with how far along the route the camera is, and once with `null` when
   * the flight ends. The section's cursor is driven from it, which is what keeps the two
   * halves of the instrument reading the same moment.
   */
  onFlyoverTick?: (distanceM: number | null) => void;
  /** Called once when the film reaches its end of its own accord, so the control can reset. */
  onFlyoverEnd?: () => void;
  /**
   * Reported after every gesture settles, not during one — the only reader is the slope key,
   * which needs to know whether the overlay is drawable, and a legend re-rendering sixty
   * times a second through a pinch buys nothing.
   */
  onZoomChange?: (zoom: number) => void;
  className?: string;
}

const ROUTE_SOURCE = 'route';
const POINT_SOURCE = 'route-points';
const CURSOR_SOURCE = 'route-cursor';

/**
 * Which plate a waypoint prints on.
 *
 * `hazard` is the only kind that gets the survey plate, and it gets it for the same reason
 * the live position dot does — it is a safety fact, and the plate means safety and nothing
 * else. Water features take the water plate, high ground takes contour, and everything
 * built by people takes the muted ink so a car park never outranks a summit.
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

  // The two ends are always marked even when OSM has no trailhead node — a route drawn with
  // no start is a route you cannot tell the direction of, and every stat on the page is
  // measured from one particular end of it.
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

  // The map is created once and closes over its first render, so callbacks and the framing
  // are read back through refs. Putting them in the effect's deps instead would tear the map
  // down and rebuild it every time the parent re-rendered with a fresh closure.
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

  // ── Create once ───────────────────────────────────────────────────────────────────
  const scaleBar = useScaleBar(110);
  const units = useUnits();

  useEffect(() => {
    if (!container.current || map.current) return;

    let protocol: Protocol | null = null;
    if (pmtilesUrl()) {
      protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    }

    // Unconditional, and never removed — the handler is cheap, and a `slope://` source in a
    // style that arrives before the protocol does is a tile error rather than a retry.
    registerSlopeProtocol();

    // Same shape, same reason: a right-to-left summit name drawn before the shaper loads is
    // drawn backwards. See `map/rtl`.
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
      // Rotation and pitch are gestures the flat map has no use for — there is one trail and
      // no reason to spin it — so they start disabled and are switched on with terrain by the
      // effect below. `pitchWithRotate` is deliberately left at its default: it can only be
      // set at construction, so turning it off here would permanently cost the right-drag its
      // tilt, and the layer switch promises exactly that gesture. `dragRotate: false` already
      // withholds the whole handler until there is ground worth tilting.
      //
      // The pitch ceiling is raised here rather than in the effect for the same reason —
      // `maxPitch` is construction-only, and a flyover pitched past MapLibre's default 60
      // would be silently clamped with the horizon never coming into frame.
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
      // The opening zoom is whatever `fitBounds` chose for this particular trail, which for
      // a long route is far enough out that the slope layer cannot draw. Report it now so
      // the key knows that before the reader touches anything.
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

  // ── Base map ──────────────────────────────────────────────────────────────────────
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

  // ── Where the ground is, under the middle of the frame ────────────────────────────
  /*
   * MapLibre's own answer to this is wrong for our DEM, and the symptom is the whole 3D view.
   *
   * With terrain on, the map holds the centre point on the surface: each frame it looks up the
   * elevation under the centre and re-aims there. That lookup asks `Terrain.getSourceTile` for
   * a tile at `transform.tileZoom − 1` and hikes *up* to parents from there. Our terrarium
   * source is `tileSize: 256`, which caches its tiles one level further in than that, so the
   * search starts below what is loaded, finds nothing, and returns **zero** — not null, not the
   * parent's value, zero. `getCenterElevation()` duly reads 0 over a route at 2,400 m.
   *
   * A camera aimed at a point 2,400 m underground still has to hit the mesh somewhere, and it
   * does so much nearer than intended: the ground arrives at better than twice the scale the
   * zoom asked for, and the route climbs off the top of the frame. Which is what "ticking 3D
   * terrain loses the trail" actually was — not the pitch, and not the zoom, which the probe
   * measured as identical either way.
   *
   * `queryTerrainElevation` answers the same question correctly at the same instant, because it
   * derives its own zoom from the loaded tiles instead of being handed a broken one. So the
   * clamp is switched off and the centre elevation is set from that, on `moveend` and `idle` —
   * the two moments the camera is at rest and the answer is worth having.
   */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !terrain || flyover) return;

    instance.setCenterClampedToGround(false);

    const sync = () => {
      // `setCenterElevation` is a `jumpTo`, which fires the events that call this; a metre of
      // slack is what stops two floats from chasing each other. The DEM does not depend on the
      // camera height, so the second pass always sees a delta of zero and stops.
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

  // ── Rotation follows terrain ──────────────────────────────────────────────────────
  /*
   * A mesh you cannot hike round is a picture of a mesh. Once the ground has a third
   * dimension, being able to swing the camera and see which side of the ridge the path takes
   * is most of the value — so the gestures are enabled with it and disabled again when the
   * map goes back to being a sheet, along with any pitch the reader left behind.
   *
   * Re-framing on both edges is what makes the transition mean "same map, tilted" rather than
   * "same map, somewhere else": the trail's own bounds, so the route is the thing that stays
   * put while everything around it changes. It tilts at the same time because from directly
   * overhead a mesh and a hillshade of the same DEM are the same picture, and without the tilt
   * the only evidence the box did anything is a gesture the reader has not tried yet.
   *
   * Only from flat, though — a reader who has already dragged the view to their own angle did
   * not ask to have it corrected — and never mid-flight, where the animation loop owns the
   * camera and a `fitBounds` underneath it would be two hands on the same wheel.
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

  // ── The flyover ───────────────────────────────────────────────────────────────────
  /*
   * One `requestAnimationFrame` loop, one `jumpTo` per frame, and no React state in the
   * middle of it. `jumpTo` rather than `easeTo`: the pose already carries the easing, because
   * the pacing is Tobler's rather than a curve chosen for how it looks, and asking MapLibre
   * to smooth between two poses that are 16 ms apart would flatten exactly the labouring on
   * the climb that the flyover exists to show.
   *
   * Pressing play usually switches terrain on in the same commit, which rebuilds the style —
   * so the loop waits for `idle` rather than starting over a half-built map. Without that the
   * first second of every first flight is a camera sweeping across flat ground while the mesh
   * loads under it, which reads as the terrain failing rather than arriving.
   */
  useEffect(() => {
    if (!flyover) return;
    const instance = map.current;
    if (!instance || !ready.current) return;

    let frame = 0;
    let cancelled = false;

    /*
     * The camera is told how high the ground is, rather than being left to find out.
     *
     * Same broken lookup as the effect above, with a second failure mode stacked on it: a
     * flyover moves faster than DEM tiles load, so even a working search would miss. Told the
     * ground is at sea level over a route at 2,500 m, MapLibre places the camera two kilometres
     * inside the mountain, where back-face culling leaves a completely empty frame — it renders
     * nothing at all, silently, with no console error and a progress bar that keeps counting.
     *
     * We already know the answer. Every pose carries `eleM` from our own DEM pass, sampled at
     * ingest and stored with the profile, so the camera is positioned from data that is on the
     * page rather than from tiles that are in flight — and `jumpTo` takes an explicit
     * `elevation` in preference to its own lookup, which is what makes that stick.
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
      // No animation at all for a reader who has asked for none — a pitched camera sweeping
      // over terrain is close to the worst thing a map can do to a vestibular setting. What
      // survives being still is the arrangement of the ground: the whole route in frame,
      // tilted, seen from the direction the high point lies in.
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
      // The section marks the summit rather than nothing, so the still has a reading to go
      // with it — the same pairing the moving version relies on.
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
          // Ending is the parent's business: it owns the play state, and it setting `flyover`
          // to null is what runs the cleanup below and puts the map back on its bounds.
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
      // Hand the centre point back to the terrain before re-framing, so the map the reader is
      // left holding tracks the ground under it again the moment they pan.
      instance.setCenterClampedToGround(clamped);
      restore();
    };
  }, [flyover]);

  // ── Cursor ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.getSource<GeoJSONSource>(CURSOR_SOURCE)?.setData(cursorCollection(cursor));
  }, [cursor]);

  return (
    <div
      ref={container}
      className={className ?? ''}
      // Labelled, not hidden.
      //
      // The route is described in full by the stats, the profile and the waypoint list on
      // this page, so the instinct is `aria-hidden` and for a while that is what this was.
      // It is the wrong tool. `aria-hidden` removes an element from the accessibility tree
      // but not from the tab order, and MapLibre puts `tabindex="0"` on its canvas and ships
      // real buttons for zoom — so hiding this left three tab stops that a screen reader
      // arrives at with nothing to say. WCAG 4.1.2, and worse in practice than the noise it
      // was avoiding: a user who cannot see the map now cannot tell what they have landed on
      // or how many more presses it takes to get out.
      //
      // A named region costs one announcement and makes the rest legible. `region` rather
      // than `application` because the arrow keys pan a view here; they do not drive a widget
      // with its own key semantics, and `application` would switch off the reading-mode keys
      // used to skip past it.
      role="region"
      aria-label="Map of the trail route"
    />
  );
}

/**
 * The route, its waypoints, and the cursor — bottom to top.
 *
 * The line is drawn thicker here than on the browse map. There it was one of sixty and had
 * to stay out of its neighbours' way; here it is the subject, and a hairline subject on a
 * shaded hillside is a line the reader has to hunt for.
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
