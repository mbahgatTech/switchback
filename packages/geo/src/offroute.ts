import type { LngLat } from '@switchback/core';
import { nearestPointOnLine } from './distance';

/**
 * Wrong-turn detection. A bare cross-track threshold is unusable in the field — GPS under canopy
 * throws single fixes 100 m sideways — so an alert requires *persistence*: a run of consecutive
 * off-route fixes spanning a minimum wall-clock duration, with hysteresis on the return threshold
 * so hiking the edge of the corridor does not alert every few seconds.
 */

export interface OffRouteConfig {
  /** Cross-track distance beyond which a fix counts as off-route. */
  offRouteThresholdM: number;
  /** Tighter threshold that must be met to clear an active alert. */
  onRouteThresholdM: number;
  /** Consecutive off-route fixes required before alerting. */
  minConsecutiveFixes: number;
  /** Wall-clock time the run must span, guarding against a burst of rapid fixes. */
  minDurationS: number;
  /** Fixes less accurate than this are ignored rather than trusted. */
  maxAccuracyM: number;
  /** Minimum gap between repeat alerts. */
  realertIntervalS: number;
}

export const DEFAULT_OFF_ROUTE_CONFIG: OffRouteConfig = {
  offRouteThresholdM: 60,
  onRouteThresholdM: 35,
  minConsecutiveFixes: 3,
  minDurationS: 45,
  maxAccuracyM: 50,
  realertIntervalS: 300,
};

export interface Fix {
  lng: number;
  lat: number;
  /** Epoch milliseconds. */
  t: number;
  /** Horizontal accuracy in metres, if the platform reports it. */
  accuracyM?: number | null;
}

export interface OffRouteState {
  isOffRoute: boolean;
  consecutiveOffRoute: number;
  /** Timestamp of the first fix in the current off-route run. */
  offRouteSinceT: number | null;
  lastAlertT: number | null;
  /** Cross-track distance of the most recent usable fix. */
  lastDistanceM: number | null;
  /** Along-route distance of the most recent usable fix. */
  lastAlongM: number | null;
}

export function initialOffRouteState(): OffRouteState {
  return {
    isOffRoute: false,
    consecutiveOffRoute: 0,
    offRouteSinceT: null,
    lastAlertT: null,
    lastDistanceM: null,
    lastAlongM: null,
  };
}

export interface OffRouteUpdate {
  state: OffRouteState;
  /** True on the single tick where an alert should fire. */
  shouldAlert: boolean;
  /** True on the tick where the user has returned to the trail. */
  didReturn: boolean;
  distanceM: number | null;
  alongM: number | null;
}

/** Fold one GPS fix into the detector. Pure state-in/state-out, so web and native agree. */
export function updateOffRoute(
  state: OffRouteState,
  fix: Fix,
  route: readonly LngLat[],
  config: OffRouteConfig = DEFAULT_OFF_ROUTE_CONFIG,
): OffRouteUpdate {
  // A fix we cannot trust is worse than no fix: acting on it produces the false alarm this
  // detector exists to avoid.
  if (fix.accuracyM != null && fix.accuracyM > config.maxAccuracyM) {
    return { state, shouldAlert: false, didReturn: false, distanceM: null, alongM: null };
  }
  if (route.length < 2) {
    return { state, shouldAlert: false, didReturn: false, distanceM: null, alongM: null };
  }

  const nearest = nearestPointOnLine([fix.lng, fix.lat], route);
  const distanceM = nearest.distM;
  const alongM = nearest.alongM;

  const next: OffRouteState = {
    ...state,
    lastDistanceM: distanceM,
    lastAlongM: alongM,
  };

  // Hysteresis: leaving crosses the outer threshold, returning crosses the tighter inner one.
  const threshold = state.isOffRoute ? config.onRouteThresholdM : config.offRouteThresholdM;

  if (distanceM > threshold) {
    next.consecutiveOffRoute = state.consecutiveOffRoute + 1;
    next.offRouteSinceT = state.offRouteSinceT ?? fix.t;

    const runDurationS = (fix.t - next.offRouteSinceT) / 1000;
    const persistent =
      next.consecutiveOffRoute >= config.minConsecutiveFixes && runDurationS >= config.minDurationS;

    const cooledDown =
      state.lastAlertT === null || (fix.t - state.lastAlertT) / 1000 >= config.realertIntervalS;

    if (persistent && cooledDown) {
      next.isOffRoute = true;
      next.lastAlertT = fix.t;
      return { state: next, shouldAlert: true, didReturn: false, distanceM, alongM };
    }

    next.isOffRoute = next.isOffRoute || persistent;
    return { state: next, shouldAlert: false, didReturn: false, distanceM, alongM };
  }

  const didReturn = state.isOffRoute;
  next.isOffRoute = false;
  next.consecutiveOffRoute = 0;
  next.offRouteSinceT = null;
  if (didReturn) next.lastAlertT = null;

  return { state: next, shouldAlert: false, didReturn, distanceM, alongM };
}

/**
 * Remaining distance to the end of the route from an along-route position.
 * On an out-and-back the caller passes the doubled length.
 */
export function remainingDistanceM(totalLengthM: number, alongM: number): number {
  return Math.max(0, totalLengthM - alongM);
}
