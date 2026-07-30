'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { AirQualityGrid, BBox, Heatmap, TrailMapItem } from '@switchback/core';
import { type BasemapId, buildStyle, pmtilesUrl } from './basemap';
import { AIR_QUALITY_SOURCE, airQualityFeatures } from './air-quality';
import { HEATMAP_SOURCE, heatmapFeatures } from './heatmap';
import { registerSlopeProtocol } from './slope-protocol';
import { registerRTLText } from './rtl';
import {
  CLUSTER_LAYER,
  HIT_LAYER,
  POINT_LAYER,
  POINT_SOURCE_ID,
  addTrailLayers,
  applyState,
  boundsOf,
  fit,
  setActivePoint,
  setSelectedLine,
  setTrailData,
} from './trail-layers';
import { useScaleBar } from './scale';
import { useUnits } from '../units';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * The map.
 *
 * It owns the viewport and nothing else: it reports the box it is looking at, draws the
 * trails it is handed, and says which one the pointer is on. Fetching, filtering and
 * ranking all live above it. That split is what lets the same component serve browse now
 * and navigation in Phase 4, where the trails come from a downloaded bundle instead.
 *
 * The sources and layers themselves are in `./trail-layers`, shared with `/embed/map` —
 * the page the iOS app loads into a `WebView`. One cartography, two clients.
 */

export interface TrailMapProps {
  trails: readonly TrailMapItem[];
  /** Debounced viewport, in `[w, s, e, n]`. Fires on settle, not during the drag. */
  onViewportChange: (bbox: BBox, zoom: number) => void;
  selectedId: string | null;
  onSelect: (trailId: string | null) => void;
  hoveredId: string | null;
  onHover: (trailId: string | null) => void;
  basemap: BasemapId;
  hillshade: boolean;
  /** Avalanche-convention slope shading over the DEM. Off by default; see `./slope`. */
  slope: boolean;
  /**
   * The European AQI over the current viewport, or `null` when the overlay is off.
   *
   * Passed as data rather than as a flag because the map has no business knowing how the
   * grid was obtained — the query, its cache and its loading state belong to the page.
   */
  airQuality?: AirQualityGrid | null;
  /**
   * Recorded activity aggregated to a lattice, or `null` when the overlay is off.
   *
   * Same contract as `airQuality`, and for the same reason. Worth stating once here: the
   * k-anonymity floor that makes this publishable is applied in the query, so anything that
   * reaches this prop is already safe to draw. The map never filters, and must not be the
   * place anyone looks for the privacy control.
   */
  heatmap?: Heatmap | null;
  /**
   * Where to open. Read exactly once, at construction, by the create-once effect below — so
   * changing it later is inert, and adding it to that effect's dependencies would tear down
   * and rebuild the whole MapLibre instance on every render. The lever for a move after mount
   * is `frame`, with its nonce.
   *
   * The caller decides where "here" is, and the callers do not agree: explore and plan derive
   * it from the reader (`lib/place.ts`), the embed takes it from query params handed over by
   * the phone. This prop has no opinion.
   */
  initialCenter: [number, number];
  initialZoom: number;
  /** An explicit "go here", from search. See `MapFrame` for why it carries a nonce. */
  frame?: MapFrame | null;
}

/**
 * A commanded viewport change.
 *
 * The `nonce` is not ceremony. Searching "Vesper Peak", panning away to look at the ridge
 * to the north, then picking Vesper Peak from the list again is an ordinary thing to do,
 * and with a bare bbox the second pick changes no prop and moves no map — the component
 * would be right to conclude nothing happened. A frame is an event, not a state, and the
 * nonce is what makes an identical event distinguishable from no event.
 */
export interface MapFrame {
  bbox: BBox;
  nonce: number;
}

/**
 * How long the viewport must sit still before we ask for its trails.
 *
 * A drag fires `move` continuously and `moveend` once, but a flick fires `moveend` several
 * times as it decelerates. Without this a single gesture across a cold region queues four
 * overlapping Overpass fetches for overlapping tiles.
 */
const SETTLE_MS = 320;

export function TrailMap(props: TrailMapProps) {
  const {
    trails,
    onViewportChange,
    selectedId,
    onSelect,
    hoveredId,
    onHover,
    basemap,
    hillshade,
    slope,
    airQuality = null,
    heatmap = null,
    initialCenter,
    initialZoom,
    frame,
  } = props;

  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  /*
   * The callbacks are re-created on every render of the parent, and re-registering
   * MapLibre listeners each time would leak handlers and re-fire the viewport query. The
   * listeners are registered once against these boxes, which always hold the current
   * function.
   */
  const handlers = useRef({ onViewportChange, onSelect, onHover });
  handlers.current = { onViewportChange, onSelect, onHover };

  const previousHover = useRef<string | null>(null);
  const previousSelection = useRef<string | null>(null);

  // ── Create once ───────────────────────────────────────────────────────────────────
  const scaleBar = useScaleBar(120);
  const units = useUnits();

  useEffect(() => {
    if (!container.current || map.current) return;

    // PMTiles serves a whole archive over HTTP range requests, so MapLibre needs the
    // protocol handler before any style referencing `pmtiles://` is loaded. Registered
    // only when there is an archive to read, since it is global state on the library.
    let protocol: Protocol | null = null;
    if (pmtilesUrl()) {
      protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    }

    // Unconditional, and never removed — the handler is cheap, and a `slope://` source in a
    // style that arrives before the protocol does is a tile error rather than a retry.
    registerSlopeProtocol();

    // Likewise global, likewise unconditional: a name in Arabic or Hebrew that arrives
    // before the shaper does is drawn backwards and stays that way until the tile is
    // re-laid out. See `./rtl`.
    registerRTLText();

    const instance = new maplibregl.Map({
      container: container.current,
      style: buildStyle(basemap, { hillshade, slope, units }),
      center: initialCenter,
      zoom: initialZoom,
      // Nothing in this product is served in a projection where rotating helps, and a
      // map that has quietly rotated is a map you cannot read a bearing off.
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
      // Our own attribution bar renders in the page, where it is legible against the
      // panel rather than fighting the imagery.
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    instance.addControl(scaleBar(), 'bottom-left');

    let settle: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        handlers.current.onViewportChange(boundsOf(instance), instance.getZoom());
      }, SETTLE_MS);
    };

    instance.on('moveend', report);
    instance.on('load', () => {
      addTrailLayers(instance);
      handlers.current.onViewportChange(boundsOf(instance), instance.getZoom());
    });

    return () => {
      clearTimeout(settle);
      instance.remove();
      map.current = null;
      if (protocol) maplibregl.removeProtocol('pmtiles');
    };
    // Intentionally once. Base map and viewport changes are handled by the effects below;
    // re-running this one would tear down and rebuild the map on every pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleBar]);

  // ── Interaction ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    const enter = (event: maplibregl.MapLayerMouseEvent) => {
      // MapLibre types feature properties as `any`, which is honest — they came off a tile.
      // Narrowing through `unknown` is what keeps that `any` from spreading into our state.
      const id: unknown = event.features?.[0]?.properties?.id;
      instance.getCanvas().style.cursor = 'pointer';
      handlers.current.onHover(typeof id === 'string' ? id : null);
    };
    const leave = () => {
      instance.getCanvas().style.cursor = '';
      handlers.current.onHover(null);
    };
    const click = (event: maplibregl.MapLayerMouseEvent) => {
      const id: unknown = event.features?.[0]?.properties?.id;
      handlers.current.onSelect(typeof id === 'string' ? id : null);
    };

    /**
     * Clicking a cluster opens it.
     *
     * A cluster that does nothing when clicked is a dead end — it tells you thirty trails
     * are here and gives you no way in. `getClusterExpansionZoom` returns the zoom at which
     * this particular group breaks apart, which is the only zoom worth flying to: one step
     * closer and it is still one circle, several steps and you have overshot the range.
     */
    const clusterClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const clusterId: unknown = feature?.properties?.cluster_id;
      if (typeof clusterId !== 'number') return;

      const source = instance.getSource<GeoJSONSource>(POINT_SOURCE_ID);
      if (!source) return;

      const centre =
        feature?.geometry.type === 'Point'
          ? (feature.geometry.coordinates as [number, number])
          : null;

      void source
        .getClusterExpansionZoom(clusterId)
        .then((zoom) => {
          instance.easeTo({
            ...(centre ? { center: centre } : {}),
            zoom,
            duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 480,
          });
        })
        .catch(() => {
          // The source re-clustered under us mid-click. One zoom step still opens it.
          instance.zoomIn();
        });
    };

    const pointerOn = () => {
      instance.getCanvas().style.cursor = 'pointer';
    };

    // Clicking bare ground clears the selection — the same gesture as putting the sheet
    // down. Registered on the map rather than the layer, and ordered after it.
    const clickAway = (event: maplibregl.MapMouseEvent) => {
      // Only the layers actually present at this zoom, because `queryRenderedFeatures`
      // throws on an unknown layer id rather than ignoring it.
      const layers = [HIT_LAYER, POINT_LAYER, CLUSTER_LAYER].filter((id) => instance.getLayer(id));
      if (layers.length === 0) return;
      if (instance.queryRenderedFeatures(event.point, { layers }).length === 0) {
        handlers.current.onSelect(null);
      }
    };

    instance.on('mousemove', HIT_LAYER, enter);
    instance.on('mouseleave', HIT_LAYER, leave);
    instance.on('click', HIT_LAYER, click);
    instance.on('mousemove', POINT_LAYER, enter);
    instance.on('mouseleave', POINT_LAYER, leave);
    instance.on('click', POINT_LAYER, click);
    instance.on('mouseenter', CLUSTER_LAYER, pointerOn);
    instance.on('mouseleave', CLUSTER_LAYER, leave);
    instance.on('click', CLUSTER_LAYER, clusterClick);
    instance.on('click', clickAway);

    return () => {
      instance.off('mousemove', HIT_LAYER, enter);
      instance.off('mouseleave', HIT_LAYER, leave);
      instance.off('click', HIT_LAYER, click);
      instance.off('mousemove', POINT_LAYER, enter);
      instance.off('mouseleave', POINT_LAYER, leave);
      instance.off('click', POINT_LAYER, click);
      instance.off('mouseenter', CLUSTER_LAYER, pointerOn);
      instance.off('mouseleave', CLUSTER_LAYER, leave);
      instance.off('click', CLUSTER_LAYER, clusterClick);
      instance.off('click', clickAway);
    };
  }, []);

  // ── Data ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    /**
     * Land the trails, and keep trying until they land.
     *
     * The old shape of this was `push() ?? once('idle', push)`, and the fallback was the
     * bug. `idle` is emitted at the *end* of a render pass, so it only ever arrives if the
     * map is going to render again — and a map sitting still with its tiles already drawn
     * is not. Every ordering where the query resolves into a resting map therefore parked
     * the data on a listener that would not fire until the reader happened to pan, which
     * is the complaint exactly: trails fetched, trails correct, map empty.
     *
     * So: try now, and if the sources are not there yet, retry on each of the three events
     * that can create them — a style loading, a source being added, a render finishing —
     * and unsubscribe the moment one works. Three listeners rather than one because none of
     * them is guaranteed on its own, and an extra `setData` on a source that already holds
     * this exact collection costs a diff MapLibre was going to do anyway.
     */
    if (setTrailData(instance, trails)) {
      reportLanded(container.current, trails.length);
      return;
    }

    const off = () => {
      instance.off('styledata', retry);
      instance.off('sourcedata', retry);
      instance.off('idle', retry);
    };
    const retry = () => {
      if (!setTrailData(instance, trails)) return;
      reportLanded(container.current, trails.length);
      off();
    };

    instance.on('styledata', retry);
    instance.on('sourcedata', retry);
    instance.on('idle', retry);
    return off;
  }, [trails]);

  // ── Air quality ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const push = () => {
      instance
        .getSource<GeoJSONSource>(AIR_QUALITY_SOURCE)
        ?.setData(airQualityFeatures(airQuality));
    };
    if (instance.isStyleLoaded() && instance.getSource(AIR_QUALITY_SOURCE)) push();
    else void instance.once('idle', push);
  }, [airQuality]);

  // ── Activity heatmap ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const push = () => {
      instance.getSource<GeoJSONSource>(HEATMAP_SOURCE)?.setData(heatmapFeatures(heatmap));
    };
    if (instance.isStyleLoaded() && instance.getSource(HEATMAP_SOURCE)) push();
    else void instance.once('idle', push);
  }, [heatmap]);

  // ── Commanded framing ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance || !frame) return;
    // Deliberately not `maxZoom: 15` like a trail selection. A search result may be a
    // summit node widened to 1.6 km, and clamping that would leave the peak framed at
    // street level with nothing around it. `frameOf` in the geocoder has already decided
    // how much ground the result deserves; second-guessing it here would undo that.
    fit(instance, frame.bbox, 17);
    // `frame.bbox` is read but is not a trigger — the nonce is the event. See `MapFrame`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.nonce]);

  // ── Base map ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    // `setStyle` drops every layer we added, so the trail layers go back on once the new
    // base has loaded. `styledata` rather than `load`, which has long since fired.
    const restore = () => {
      addTrailLayers(instance);
      if (setTrailData(instance, trails)) reportLanded(container.current, trails.length);
      instance
        .getSource<GeoJSONSource>(AIR_QUALITY_SOURCE)
        ?.setData(airQualityFeatures(airQuality));
      instance.getSource<GeoJSONSource>(HEATMAP_SOURCE)?.setData(heatmapFeatures(heatmap));
      applyState(instance, 'selected', null, previousSelection.current);
      applyState(instance, 'hovered', null, previousHover.current);
      setActivePoint(instance, previousSelection.current ?? previousHover.current);
      setSelectedLine(instance, previousSelection.current);
    };
    instance.setStyle(buildStyle(basemap, { hillshade, slope, units }));
    void instance.once('styledata', restore);
    // `trails` is read inside `restore` but is not a trigger: a data change must not
    // rebuild the style. The data effect above owns that path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, hillshade, slope, units]);

  // ── Hover and selection ───────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    applyState(instance, 'hovered', previousHover.current, hoveredId);
    previousHover.current = hoveredId;
    // Selection outranks hover for the ring: pointing at a second entry in the index should
    // not silently move the mark away from the one you opened.
    setActivePoint(instance, previousSelection.current ?? hoveredId);
  }, [hoveredId]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    applyState(instance, 'selected', previousSelection.current, selectedId);
    previousSelection.current = selectedId;
    setActivePoint(instance, selectedId ?? previousHover.current);
    setSelectedLine(instance, selectedId);

    if (!selectedId) return;
    const trail = trails.find((candidate) => candidate.id === selectedId);
    if (!trail) return;
    fit(instance, trail.bbox, 15);
  }, [selectedId, trails]);

  return (
    <div
      ref={container}
      // Sized, not positioned. MapLibre's own stylesheet sets `.maplibregl-map { position:
      // relative }` — it needs the container to be the positioning context for its canvas
      // and controls, all of which are absolute. That rule has the same specificity as
      // Tailwind's `.absolute` and is imported from this module, so it loads after the
      // utilities layer and wins on source order. An `absolute inset-0` container therefore
      // silently becomes `relative`, `inset-0` stops sizing anything, and the box collapses
      // to the height of its content — which is zero, because every child is absolute. The
      // map renders perfectly into a canvas nobody can see. `h-full` asks the parent for the
      // height instead, which works whichever way `position` resolves.
      className="h-full w-full"
      // Named and reachable, not hidden.
      //
      // The tempting move is `aria-hidden` — the trail list beside this is the accessible
      // equivalent, and announcing a canvas with hundreds of unnamed children helps nobody.
      // But MapLibre puts `tabindex="0"` on its canvas so the map can be panned and zoomed
      // from the keyboard, and `aria-hidden` over a focusable element is the worst of both:
      // the control still takes a tab stop, and a screen reader now lands on something it
      // has been told does not exist, with nothing to announce. That is a WCAG 4.1.2
      // failure rather than a tidier tree.
      //
      // So it is labelled instead. `region` rather than `application` because the arrow
      // keys here pan a view; they do not operate a widget with its own key semantics, and
      // `application` would suppress the reading-mode shortcuts a user relies on to get
      // back out to the list.
      role="region"
      aria-label="Map of trails in the current view"
    />
  );
}

/**
 * Say on the container how many trails the map is actually holding.
 *
 * Deliberately not React state. State would make this a restatement of the props — "we
 * rendered with 20 trails" — and the props were never in doubt; what was in doubt is
 * whether those 20 lines reached the GeoJSON source behind the canvas. Written straight
 * onto the DOM node, the attribute can only be set on the path where `setTrailData`
 * returned true, so it is a claim about the map rather than about the render.
 *
 * That makes it the one honest handle on a WebGL canvas from outside: the browser test
 * waits on it, and anyone debugging an empty map can read it in devtools and immediately
 * know which half of the problem they have — no attribute means the data never landed,
 * `data-trails="0"` means it landed and there is nothing here.
 */
function reportLanded(node: HTMLElement | null, count: number): void {
  if (node) node.dataset.trails = String(count);
}
