'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { buildStyle } from '../map/basemap';
import { TRACK_FIT_PADDING_PX, addTrackLayers, setTrack, trackBounds } from '../map/track-layers';
import { useScaleBar } from '../map/scale';
import { registerRTLText } from '../map/rtl';
import { useUnitsRef } from '../units';
import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * A finished hike, on the website.
 *
 * The fourth map in the product and the only one that is finished — nothing on it will move
 * again. That is the whole design: no camera to follow, no viewport to report, no selection to
 * make. It draws one line, puts a mark at each end, frames it, and stops.
 *
 * What it draws lives in `map/track-layers`, shared with the map the iOS app loads into a
 * `WebView`, so a hike looks the same on both. What *this* file owns is the frame around it:
 * the controls, the chrome styling, and how the canvas presents itself to a screen reader.
 */

export interface TrackMapProps {
  /** `[lng, lat, eleM | null]`, as `activities.get` returns it. */
  track: ReadonlyArray<readonly [number, number, number | null]>;
  className?: string;
}

export function TrackMap({ track, className }: TrackMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);

  const scaleBar = useScaleBar(110);
  const units = useUnitsRef();

  useEffect(() => {
    if (!container.current || map.current) return;
    if (track.length < 2) return;

    registerRTLText();

    const bounds = trackBounds(track);
    if (!bounds) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: buildStyle('relief', { hillshade: true, units: units.current }),
      bounds,
      fitBoundsOptions: { padding: TRACK_FIT_PADDING_PX, maxZoom: 15 },
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.addControl(scaleBar(), 'bottom-left');

    instance.on('load', () => {
      addTrackLayers(instance);
      setTrack(instance, track);
    });

    return () => {
      instance.remove();
      map.current = null;
    };
    // The track is fixed for the life of this page — a finished hike does not gain fixes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleBar]);

  return (
    <div
      ref={container}
      className={className ?? ''}
      // The figures this canvas encodes are all printed beside it in real type, so this is
      // the illustration rather than the record — but that argues for a quiet region, not
      // for `aria-hidden`, which is what it was. Hidden elements keep their tab stops:
      // MapLibre's canvas is `tabindex="0"` and its zoom controls are buttons, so hiding the
      // container only produced focusable content with nothing to announce. WCAG 4.1.2.
      role="region"
      aria-label="Map of the hike"
    />
  );
}
