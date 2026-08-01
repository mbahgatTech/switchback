'use client';

import { createContext, useContext, useRef } from 'react';
import type { UnitSystem } from '@switchback/core';

/**
 * The reader's unit system for the client tree. The `packages/core` formatters keep their
 * explicit argument for use from the API and scripts; this is the one place that answers
 * "which system, for this reader, right now". Server components call `viewerUnits()` instead.
 */
const UnitsContext = createContext<UnitSystem>('metric');

export function UnitsProvider({
  units,
  children,
}: {
  units: UnitSystem;
  children: React.ReactNode;
}) {
  return <UnitsContext.Provider value={units}>{children}</UnitsContext.Provider>;
}

/** Defaults to metric with no provider above — a wrong unit for one reader, not a crash. */
export function useUnits(): UnitSystem {
  return useContext(UnitsContext);
}

/**
 * The units a component was handed, or the reader's own if it was handed none. A helper rather
 * than `given ?? useUnits()` at each site, which short-circuits and violates hook order the
 * moment the same component renders once with the prop and once without.
 */
export function useUnitsOr(given: UnitSystem | undefined): UnitSystem {
  const inherited = useContext(UnitsContext);
  return given ?? inherited;
}

/**
 * The reader's units for a map built once and never rebuilt. Reading `useUnits()` straight into
 * those effects puts `units` in the dependency array, and the consequence is a teardown rather
 * than a restyle — the canvas goes and every tile is refetched. Read through a ref instead, so
 * those maps label their summits in whatever system was current when they mounted.
 *
 * Assigned during render rather than in an effect, so it is correct the first time a map effect
 * reads it whatever order the hooks registered in.
 */
export function useUnitsRef(): React.RefObject<UnitSystem> {
  const units = useContext(UnitsContext);
  const latest = useRef(units);
  latest.current = units;
  return latest;
}
