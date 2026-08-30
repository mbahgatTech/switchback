'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type {
  BBox,
  LngLat,
  MapIn,
  MapOut,
  MapQuery,
  TrailMapItem,
  UnitSystem,
} from '@switchback/core';
import { encodeMapOut, parseMapIn } from '@switchback/core';
import { useTRPC } from '@/trpc/react';
import { type BasemapId, buildStyle, pmtilesUrl } from './basemap';
import { browsePollInterval } from './browse-poll';
import { registerRTLText } from './rtl';
import { registerSlopeProtocol } from './slope-protocol';
import {
  CLUSTER_LAYER,
  HIT_LAYER,
  POINT_LAYER,
  POINT_SOURCE_ID,
  SOURCE_ID,
  addLocateLayers,
  addTrailLayers,
  applyState,
  boundsOf,
  fit,
  setActivePoint,
  setLocate,
  setSelectedLine,
  setTrailData,
} from './trail-layers';
import { TRACK_FIT_PADDING_PX, addTrackLayers, fitTrack, setTrack } from './track-layers';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * The map the iOS app holds in a `WebView`. Same MapLibre, `buildStyle` and layers as
 * `trail-map.tsx`; what differs is that there is no React parent to lift state to, so this
 * owns the viewport, the query and the selection and reports them over the bridge. See
 * `map-bridge` in `@switchback/core` for the protocol.
 *
 * It also runs standalone in a browser, which is how it is developed. No hover: a finger has
 * none, and the halo would fire on the tap that also selects.
 */

declare global {
  interface Window {
    /** Present only inside a `react-native-webview`. Absent in a browser. */
    ReactNativeWebView?: { postMessage: (data: string) => void };
    /**
     * The way in. A named global called by `injectJavaScript` rather than the `message` event,
     * which iOS delivers on `document`, Android on `window`, and some versions on both — so
     * listening to either risks a double handle or a miss. The host waits for `ready`.
     */
    __switchbackMapIn?: (raw: string) => void;
  }
}

/** How long the viewport must sit still before it is reported. See `trail-map.tsx`. */
const SETTLE_MS = 320;

/** Trails per viewport. `browse` caps at 300; a phone screen cannot use half of that. */
const LIMIT = 120;

const DEFAULT_QUERY: MapQuery = { sort: 'popularity' };

export interface EmbedMapProps {
  initialCenter: [number, number];
  initialZoom: number;
  initialBasemap: BasemapId;
  initialHillshade: boolean;
  /**
   * Which system to label summit heights in, for the first frame. A parameter rather than
   * `useUnits()` because this page loads outside the app's React tree — no `UnitsProvider`
   * above it and no session cookie inside it — so the host puts it in the URL.
   */
  initialUnits: UnitSystem;
  /**
   * Whether to look for trails in the viewport. Off for the map on a finished hike, which has
   * one line to draw and gets it over the bridge; leaving it on would bury the recorded track
   * among every path near it.
   */
  browse?: boolean;
}

export function EmbedMap(props: EmbedMapProps) {
  const { initialCenter, initialZoom, initialBasemap, initialHillshade, initialUnits } = props;
  const browsing = props.browse ?? true;
  const trpc = useTRPC();

  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);

  const [bbox, setBbox] = useState<BBox | null>(null);
  const [query, setQuery] = useState<MapQuery>(DEFAULT_QUERY);
  const [basemap, setBasemap] = useState<BasemapId>(initialBasemap);
  const [hillshade, setHillshade] = useState(initialHillshade);
  const [units, setUnits] = useState<UnitSystem>(initialUnits);
  const [failed, setFailed] = useState<string | null>(null);

  // Refs rather than state: both are read inside camera moves and message handling, and a
  // sheet being dragged would otherwise re-render the map on every frame.
  const padding = useRef({ top: 0, bottom: 0 });
  const trails = useRef<readonly TrailMapItem[]>([]);
  const selection = useRef<string | null>(null);
  /** The hike being shown, if any. A ref so a base-map change can put it back. */
  const track = useRef<readonly LngLat[]>([]);

  const post = useCallback((message: MapOut) => {
    const encoded = encodeMapOut(message);
    const bridge = window.ReactNativeWebView;
    if (bridge) {
      bridge.postMessage(encoded);
      return;
    }
    // Developed in an iframe as often as in the app. Nothing on this channel is private —
    // it is viewport boxes and public trail rows — so a wildcard target is not a leak.
    if (window.parent !== window) window.parent.postMessage(encoded, '*');
  }, []);

  const input = useMemo(
    () => ({ ...query, bbox: bbox ?? ([0, 0, 0, 0] as BBox), limit: LIMIT }),
    [query, bbox],
  );

  const browse = useQuery(
    trpc.trails.browse.queryOptions(input, {
      enabled: browsing && bbox !== null,
      // Hold the last viewport's trails on screen through the next fetch, so a pan does not
      // blank the map and repaint it.
      placeholderData: (previous) => previous,
      refetchInterval: (active) => browsePollInterval(active.state.data),
    }),
  );

  // Create once.
  useEffect(() => {
    if (!container.current || map.current) return;

    let protocol: Protocol | null = null;
    if (pmtilesUrl()) {
      protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
    }
    registerSlopeProtocol();
    registerRTLText();

    const instance = new maplibregl.Map({
      container: container.current,
      style: buildStyle(initialBasemap, {
        hillshade: initialHillshade,
        slope: false,
        units: initialUnits,
      }),
      center: initialCenter,
      zoom: initialZoom,
      dragRotate: false,
      pitchWithRotate: false,
      // Compact, and MapLibre's own rather than ours: on the phone there is no page around
      // this map to carry the ODbL notice, so it has to travel with the canvas.
      attributionControl: { compact: true },
    });
    map.current = instance;

    let settle: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const next = round(boundsOf(instance));
        const centre = instance.getCenter();
        setBbox(next);
        post({
          type: 'viewport',
          bbox: next,
          zoom: instance.getZoom(),
          center: [centre.lng, centre.lat],
        });
      }, SETTLE_MS);
    };

    instance.on('moveend', report);
    instance.on('error', (event) => {
      // Style and tile errors both land here. Only a failure to load the style is fatal;
      // a missing tile is a hole in the picture, not a dead map. MapLibre types `error` as
      // `any`, so it is narrowed rather than trusted.
      const cause: unknown = event.error;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.toLowerCase().includes('style')) setFailed(message);
    });
    instance.on('load', () => {
      addTrailLayers(instance);
      addLocateLayers(instance);
      addTrackLayers(instance);
      const next = round(boundsOf(instance));
      const centre = instance.getCenter();
      setBbox(next);
      post({ type: 'ready' });
      post({
        type: 'viewport',
        bbox: next,
        zoom: instance.getZoom(),
        center: [centre.lng, centre.lat],
      });
    });

    return () => {
      clearTimeout(settle);
      instance.remove();
      map.current = null;
      if (protocol) maplibregl.removeProtocol('pmtiles');
    };
    // Intentionally once. Everything else is an effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Take a selection, wherever it came from — the tap handler and the host's `select` message
   * both funnel through here. Guarded against re-entry: the host echoes what this map posts,
   * and without the early return that echo would re-fit the camera.
   */
  const applySelection = useCallback(
    (trailId: string | null, announce: boolean) => {
      const previous = selection.current;
      if (previous === trailId) return;
      const instance = map.current;
      selection.current = trailId;
      if (announce) post({ type: 'select', trailId });
      if (!instance) return;

      applyState(instance, 'selected', previous, trailId);
      setActivePoint(instance, trailId);
      setSelectedLine(instance, trailId);
      if (!trailId) return;

      const trail = trails.current.find((candidate) => candidate.id === trailId);
      if (!trail) return;
      // Framed into the strip of map the user can actually see, not into the rectangle
      // MapLibre thinks it has — see the `padding` message.
      fit(instance, trail.bbox, 15, {
        top: padding.current.top + 32,
        bottom: padding.current.bottom + 32,
        left: 32,
        right: 32,
      });
    },
    [post],
  );

  // Tap.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    const pick = (event: maplibregl.MapLayerMouseEvent) => {
      const id: unknown = event.features?.[0]?.properties?.id;
      applySelection(typeof id === 'string' ? id : null, true);
    };

    const clusterTap = (event: maplibregl.MapLayerMouseEvent) => {
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
          instance.easeTo({ ...(centre ? { center: centre } : {}), zoom, duration: 480 });
        })
        .catch(() => {
          instance.zoomIn();
        });
    };

    const tapAway = (event: maplibregl.MapMouseEvent) => {
      const layers = [HIT_LAYER, POINT_LAYER, CLUSTER_LAYER].filter((id) => instance.getLayer(id));
      if (layers.length === 0) return;
      if (instance.queryRenderedFeatures(event.point, { layers }).length === 0) {
        applySelection(null, true);
      }
    };

    instance.on('click', HIT_LAYER, pick);
    instance.on('click', POINT_LAYER, pick);
    instance.on('click', CLUSTER_LAYER, clusterTap);
    instance.on('click', tapAway);

    return () => {
      instance.off('click', HIT_LAYER, pick);
      instance.off('click', POINT_LAYER, pick);
      instance.off('click', CLUSTER_LAYER, clusterTap);
      instance.off('click', tapAway);
    };
  }, [applySelection]);

  // The way in. The handler is rebuilt whenever what it closes over changes; the global is a
  // stable trampoline into the current one, so the host never holds a stale function.
  const handler = useRef<(message: MapIn) => void>(() => undefined);

  handler.current = (message: MapIn) => {
    const instance = map.current;
    switch (message.type) {
      case 'query':
        setQuery(message.query);
        // A repeated query with a fresh nonce is the "search this area" gesture. The input
        // has not changed, so nothing would refetch on its own.
        void browse.refetch();
        return;
      case 'select':
        applySelection(message.trailId, false);
        return;
      case 'padding':
        padding.current = { top: message.top, bottom: message.bottom };
        return;
      case 'frame':
        if (instance)
          fit(instance, message.bbox, 17, {
            top: padding.current.top + 32,
            bottom: padding.current.bottom + 32,
            left: 32,
            right: 32,
          });
        return;
      case 'basemap':
        setBasemap(message.basemap);
        setHillshade(message.hillshade);
        return;
      case 'units':
        setUnits(message.units);
        return;
      case 'locate':
        if (!instance) return;
        setLocate(instance, message.position, message.accuracyM);
        if (message.follow && message.position) {
          instance.easeTo({
            center: message.position,
            zoom: Math.max(instance.getZoom(), 14),
            duration: 620,
          });
        }
        return;
      case 'track':
        // Held whether or not there is a map yet: the host queues until `ready`, but a
        // base-map change tears the style down and `restore` reads this to put the hike back.
        track.current = message.line;
        if (!instance) return;
        setTrack(instance, message.line);
        if (message.fit) {
          fitTrack(instance, message.line, {
            top: padding.current.top + TRACK_FIT_PADDING_PX,
            bottom: padding.current.bottom + TRACK_FIT_PADDING_PX,
            left: TRACK_FIT_PADDING_PX,
            right: TRACK_FIT_PADDING_PX,
          });
        }
        return;
    }
  };

  useEffect(() => {
    window.__switchbackMapIn = (raw: string) => {
      const message = parseMapIn(raw);
      if (message) handler.current(message);
    };
    return () => {
      delete window.__switchbackMapIn;
    };
  }, []);

  // Data out.
  useEffect(() => {
    const instance = map.current;
    const data = browse.data;
    if (!data) return;
    trails.current = data.trails;
    if (instance) {
      const push = () => {
        setTrailData(instance, data.trails);
      };
      if (instance.isStyleLoaded() && instance.getSource(SOURCE_ID)) push();
      else void instance.once('idle', push);
    }
    post({
      type: 'results',
      // Geometry is already drawn on this canvas and a list cannot render a polyline.
      // Stripping it here is what keeps a pan off the bridge — see `map-bridge`.
      trails: data.trails.map(({ geometry: _geometry, ...summary }) => summary),
      total: data.total,
      coverage: data.coverage,
      area: data.area,
    });
  }, [browse.data, post]);

  useEffect(() => {
    post({ type: 'loading', loading: browse.isFetching });
  }, [browse.isFetching, post]);

  useEffect(() => {
    const message = failed ?? (browse.error ? browse.error.message : null);
    if (message) post({ type: 'error', message });
  }, [failed, browse.error, post]);

  // Base map.
  const firstBasemap = useRef(true);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    // The map was constructed with these already applied; re-setting the style on mount
    // would drop the layers `load` just added and reload every tile for nothing.
    if (firstBasemap.current) {
      firstBasemap.current = false;
      return;
    }
    const restore = () => {
      addTrailLayers(instance);
      addLocateLayers(instance);
      addTrackLayers(instance);
      setTrailData(instance, trails.current);
      setTrack(instance, track.current);
      applyState(instance, 'selected', null, selection.current);
      setActivePoint(instance, selection.current);
      setSelectedLine(instance, selection.current);
    };
    instance.setStyle(buildStyle(basemap, { hillshade, slope: false, units }));
    void instance.once('styledata', restore);
  }, [basemap, hillshade, units]);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-canvas">
      <div
        ref={container}
        // Sized, not positioned — MapLibre's own stylesheet forces `position: relative` on
        // this element and would silently defeat `absolute inset-0`. See `trail-map.tsx`.
        className="h-full w-full"
        role="region"
        aria-label="Map of trails in the current view"
      />
      {failed ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-canvas p-xl">
          <p className="max-w-measure text-center font-text text-body text-ink-muted">
            The map could not load. Check the connection and pull down to try again.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Three decimal places — about 100 m, and the cache key the web map already uses. */
function round(bbox: BBox): BBox {
  return bbox.map((value) => Math.round(value * 1000) / 1000) as unknown as BBox;
}
