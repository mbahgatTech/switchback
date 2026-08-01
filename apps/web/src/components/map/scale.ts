'use client';

import { useCallback, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useUnits } from '../units';

/**
 * A scale bar that follows the reader's unit preference without rebuilding the map.
 *
 * Reading `units` inside the map's own effect would put it in that effect's dependencies, and
 * its cleanup disposes the map — switching to miles would refetch every tile and reset the
 * camera. So the value arrives twice: from a ref at construction (this hook is declared before
 * the map's effect, so React has already primed it), and from `setUnit` afterwards.
 *
 * `UnitSystem` and MapLibre's unit names agree on `'metric'` and `'imperial'`; if that stops
 * being true, this is where it breaks.
 */
export function useScaleBar(maxWidth: number): () => maplibregl.ScaleControl {
  const units = useUnits();
  const control = useRef<maplibregl.ScaleControl | null>(null);
  const latest = useRef(units);

  useEffect(() => {
    latest.current = units;
    control.current?.setUnit(units);
  }, [units]);

  // Stable across renders — `maxWidth` is a literal at every call site — so a map effect can
  // depend on it without that dependency ever meaning anything.
  return useCallback(() => {
    const bar = new maplibregl.ScaleControl({ maxWidth, unit: latest.current });

    /**
     * Let go of the control the moment the map does: `setUnit` re-measures against the map it
     * is attached to and throws on a detached control, and this hook's effect runs before the
     * map's, so a re-run would fire it against the control the old map disposed. `onRemove` is
     * public `IControl` and MapLibre calls it from both `removeControl` and `remove`.
     */
    const detach = bar.onRemove.bind(bar);
    bar.onRemove = () => {
      if (control.current === bar) control.current = null;
      detach();
    };

    control.current = bar;
    return bar;
  }, [maxWidth]);
}
