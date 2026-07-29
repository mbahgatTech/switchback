'use client';

import { useCallback, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useUnits } from '../units';

/**
 * A scale bar that follows the reader, on a map that does not get rebuilt when they change
 * their mind.
 *
 * Six maps in this app carry one, and all six built it inside the effect that constructs the
 * map — which is the right place for it, and exactly why they all shipped with `'metric'`
 * hard-coded. Reading the setting straight from context inside that effect would put `units`
 * in its dependency array, and the effect's cleanup disposes the map: switching to miles
 * would tear down the canvas, refetch every tile, and drop the reader back at the default
 * camera. A scale bar is not worth a map.
 *
 * So the value reaches the control twice, by two different routes. At construction it comes
 * from a ref, which the effect below has already primed — hooks called at the top of a
 * component register their effects before the map's, and React runs them in that order, so
 * the ref is current by the time the map exists. After that it comes from `setUnit`, which
 * mutates the control in place and leaves the map alone.
 *
 * ```ts
 * const scaleBar = useScaleBar(110);
 * useEffect(() => {
 *   // …
 *   instance.addControl(scaleBar(), 'bottom-left');
 * }, [scaleBar]);
 * ```
 *
 * `UnitSystem` and MapLibre's unit names agree on `'metric'` and `'imperial'`, so nothing is
 * translated between them. If that ever stops being true this is the one place it breaks.
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
     * Let go of the control the moment the map lets go of it.
     *
     * `setUnit` re-measures the bar against the map it is attached to, so calling it on a
     * detached control throws — MapLibre has already cleared the back-reference the method
     * dereferences. That is reachable, and it took the whole explore page down: this hook's
     * effect is deliberately declared *before* the map's, so when a map effect re-runs, the
     * units effect fires first, against the control the old map disposed. React StrictMode
     * re-invokes every effect on mount in development, which made it every single load.
     *
     * `onRemove` is part of the public `IControl` contract and MapLibre calls it from both
     * `removeControl` and `remove`, so wrapping it is the supported way to hear about this —
     * no private field is read, and the next `addControl` installs a fresh control anyway.
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
