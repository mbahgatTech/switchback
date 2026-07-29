import { describe, expect, it } from 'vitest';
import type { LngLat } from '@switchback/core';
import {
  DEFAULT_OFF_ROUTE_CONFIG,
  type Fix,
  initialOffRouteState,
  remainingDistanceM,
  updateOffRoute,
} from '@switchback/geo';
import { lineNorth, offset } from './helpers';

/** A 2 km north-running trail with a vertex every 100 m. */
const route: LngLat[] = lineNorth([0, 45], 2000, 21);

/** Epoch millis. Fixed, so the fixtures are deterministic. */
const T0 = 1_700_000_000_000;

/** A fix `eastM` metres off the trail, taken `atS` seconds into the hike. */
function fixAt(eastM: number, atS: number, accuracyM?: number): Fix {
  const on = route[10]!; // 1 km along
  const [lng, lat] = offset(on, 0, eastM);
  return { lng, lat, t: T0 + atS * 1000, ...(accuracyM == null ? {} : { accuracyM }) };
}

/** Fold a sequence of fixes through the detector, returning every update. */
function run(fixes: Fix[]) {
  let state = initialOffRouteState();
  return fixes.map((f) => {
    const update = updateOffRoute(state, f, route);
    state = update.state;
    return update;
  });
}

describe('updateOffRoute', () => {
  it('measures cross-track and along-route distance for a usable fix', () => {
    const [u] = run([fixAt(120, 0)]);
    expect(u!.distanceM).toBeCloseTo(120, -1);
    expect(u!.alongM).toBeCloseTo(1000, -1);
  });

  it('says nothing on the first fix off the trail', () => {
    // A single sideways fix under tree cover is GPS, not a wrong turn.
    const [u] = run([fixAt(120, 0)]);
    expect(u!.shouldAlert).toBe(false);
    expect(u!.state.consecutiveOffRoute).toBe(1);
    expect(u!.state.isOffRoute).toBe(false);
  });

  it('alerts once the run is both long enough and persistent enough', () => {
    const updates = run([fixAt(120, 0), fixAt(130, 30), fixAt(140, 60)]);
    expect(updates.map((u) => u.shouldAlert)).toEqual([false, false, true]);
    expect(updates[2]!.state.isOffRoute).toBe(true);
    expect(updates[2]!.state.lastAlertT).toBe(T0 + 60_000);
  });

  it('does not alert on a burst of fixes that spans no real time', () => {
    // Three fixes a second apart clear the count but not the 45 s duration floor.
    const updates = run([fixAt(120, 0), fixAt(120, 1), fixAt(120, 2), fixAt(120, 3)]);
    expect(updates.every((u) => !u.shouldAlert)).toBe(true);
  });

  it('resets the run as soon as the hiker is back on the trail', () => {
    const updates = run([fixAt(120, 0), fixAt(120, 30), fixAt(2, 60)]);
    expect(updates[2]!.shouldAlert).toBe(false);
    expect(updates[2]!.state.consecutiveOffRoute).toBe(0);
    expect(updates[2]!.state.offRouteSinceT).toBeNull();
  });

  it('reports the return only after an alert actually fired', () => {
    const updates = run([fixAt(120, 0), fixAt(120, 30), fixAt(120, 60), fixAt(2, 90)]);
    expect(updates[2]!.shouldAlert).toBe(true);
    expect(updates[3]!.didReturn).toBe(true);
    expect(updates[3]!.state.isOffRoute).toBe(false);
    // Cleared, so a second wrong turn alerts immediately rather than waiting out the cooldown.
    expect(updates[3]!.state.lastAlertT).toBeNull();
  });

  it('applies hysteresis: 45 m is on-route arriving, off-route leaving', () => {
    const clean = updateOffRoute(initialOffRouteState(), fixAt(45, 0), route);
    expect(clean.state.consecutiveOffRoute).toBe(0);

    // Same 45 m, but while an alert is active — inside the outer threshold, outside the
    // tighter inner one, so it does not count as a return.
    const alerted = run([fixAt(120, 0), fixAt(120, 30), fixAt(120, 60)]).at(-1)!.state;
    const edge = updateOffRoute(alerted, fixAt(45, 90), route);
    expect(edge.didReturn).toBe(false);
    expect(edge.state.isOffRoute).toBe(true);
  });

  it('holds off on a repeat alert until the cooldown has elapsed', () => {
    const alerted = run([fixAt(120, 0), fixAt(120, 30), fixAt(120, 60)]).at(-1)!.state;
    const soon = updateOffRoute(alerted, fixAt(200, 120), route);
    expect(soon.shouldAlert).toBe(false);

    const later = updateOffRoute(
      alerted,
      fixAt(200, 60 + DEFAULT_OFF_ROUTE_CONFIG.realertIntervalS),
      route,
    );
    expect(later.shouldAlert).toBe(true);
  });

  it('ignores a fix too inaccurate to act on, leaving the state untouched', () => {
    const state = initialOffRouteState();
    const u = updateOffRoute(state, fixAt(500, 0, 80), route);
    expect(u.state).toBe(state);
    expect(u.distanceM).toBeNull();
    expect(u.shouldAlert).toBe(false);
  });

  it('trusts a fix reported as accurate', () => {
    const u = updateOffRoute(initialOffRouteState(), fixAt(120, 0, 8), route);
    expect(u.state.consecutiveOffRoute).toBe(1);
  });

  it('does nothing without a route to compare against', () => {
    const state = initialOffRouteState();
    expect(updateOffRoute(state, fixAt(500, 0), []).state).toBe(state);
    expect(updateOffRoute(state, fixAt(500, 0), [[0, 45]]).state).toBe(state);
  });

  it('honours a caller-supplied config', () => {
    const twitchy = { ...DEFAULT_OFF_ROUTE_CONFIG, minConsecutiveFixes: 1, minDurationS: 0 };
    const u = updateOffRoute(initialOffRouteState(), fixAt(120, 0), route, twitchy);
    expect(u.shouldAlert).toBe(true);
  });
});

describe('remainingDistanceM', () => {
  it('counts down to the finish', () => {
    expect(remainingDistanceM(2000, 500)).toBe(1500);
    expect(remainingDistanceM(2000, 0)).toBe(2000);
  });

  it('never goes negative when GPS overshoots the end', () => {
    expect(remainingDistanceM(2000, 2100)).toBe(0);
  });
});
