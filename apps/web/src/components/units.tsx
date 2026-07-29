'use client';

import { createContext, useContext, useRef } from 'react';
import type { UnitSystem } from '@switchback/core';

/**
 * The reader's unit system, available to any component that renders a measurement.
 *
 * `packages/core/units.ts` takes the system as an explicit argument on every formatter, and
 * that is the right shape for a pure function — but it makes the *caller* responsible for
 * knowing, and the caller is frequently a card six levels below the page that did the
 * session read. What happened in practice is what always happens: the leaf components were
 * written with `'metric'` inlined at the call site as a placeholder, and the placeholder
 * shipped. Changing the setting on the profile page moved a column in the database and
 * nothing on the screen.
 *
 * So the system travels as context. The formatters keep their explicit argument — they are
 * used from the API and from scripts, where there is no React at all — and this is the one
 * place that answers "which system, for this reader, right now".
 *
 * Server components have no context, so they call `viewerUnits()` from `lib/units.ts`
 * instead — the same question, answered against the session rather than a provider. This is
 * for the client tree, where prop-drilling through twenty components is how the value gets
 * dropped again.
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

/**
 * Defaults to metric when no provider is above — which is what a signed-out reader gets,
 * and what the formatters themselves default to. A missing provider is therefore a wrong
 * unit for one reader rather than a crash for all of them.
 */
export function useUnits(): UnitSystem {
  return useContext(UnitsContext);
}

/**
 * The units a component was handed, or the reader's own if it was handed none.
 *
 * For components that take `units` as an optional prop. Those all had `= 'metric'` as the
 * default, which is the bug this context exists to fix wearing a parameter list: a caller
 * that forgets the prop silently renders kilometres to somebody who asked for miles, and
 * nothing about the call site looks wrong.
 *
 * Written as a helper rather than `given ?? useUnits()` at each site because that expression
 * short-circuits — the hook goes uncalled whenever the prop is present, which is a hook-order
 * violation the moment the same component renders once with the prop and once without.
 */
export function useUnitsOr(given: UnitSystem | undefined): UnitSystem {
  const inherited = useContext(UnitsContext);
  return given ?? inherited;
}

/**
 * The reader's units, for a map that is built once and never rebuilt.
 *
 * Three maps in this product construct their MapLibre style inside an effect that disposes
 * the map on cleanup, and never call `setStyle` afterwards — the recorder, the Lifeline
 * follower's sheet, and a finished hike. Reading `useUnits()` straight into that effect puts
 * `units` in its dependency array, and the consequence is not a restyle: it is a teardown.
 * The canvas goes, every tile is refetched, and on the recorder the map a hiker is standing
 * in the rain looking at blinks out and comes back at the default camera. `scale.ts` reached
 * the same conclusion for the same reason and phrased it well — a scale bar is not worth a
 * map — and a peak label is not worth one either.
 *
 * So the value is read through a ref, which those effects may use freely without depending
 * on. The cost is honest and small: those three maps label their summits in whatever system
 * was current when they mounted. Changing the setting means visiting settings, which unmounts
 * them, so the stale case is a second tab left open — against a map that survives being
 * looked away from, which is the trade worth making.
 *
 * Assigned during render rather than in an effect so it is already correct the first time a
 * map effect reads it, with no dependence on the order two hooks registered in.
 */
export function useUnitsRef(): React.RefObject<UnitSystem> {
  const units = useContext(UnitsContext);
  const latest = useRef(units);
  latest.current = units;
  return latest;
}
