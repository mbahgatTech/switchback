import { MAX_FIX_ACCURACY_M, type ActivityStats, type TrackFix } from '@switchback/core';
import { haversineM } from './distance';
import { GAIN_THRESHOLD_M } from './profile';
import { MAX_PLAUSIBLE_SPEED_MPS, MIN_STEP_M, STOPPED_SPEED_MPS } from './track';

/**
 * Incremental statistics, for a recorder that cannot afford to re-walk its own track.
 *
 * `summariseTrack` is a full pass — right for a finished recording, quadratic for a live one. A
 * phone in a pocket at 1 Hz for eight hours would run it 28,800 times over a track growing to
 * 28,800 fixes. Every statistic it computes is a forward fold over constant state, so the same
 * arithmetic is offered here as one.
 *
 * It lives in `geo` rather than in `apps/mobile` because the reason `summariseTrack` lives here is
 * that both clients and the server must agree on the numbers; a second implementation in the app
 * would be free to drift from the answer the server sends back at the end of the same hike.
 *
 * **Equivalent to `summariseTrack` for fixes arriving in non-decreasing `t`**, which is what the
 * recorder guarantees and what `cleanFixes` would produce anyway. Not equivalent for unordered
 * input: `cleanFixes` sorts, and a fold has already committed to what it was given. The
 * equivalence is pinned in `test/track-stats.test.ts`.
 */
export interface TrackStatsState {
  readonly firstT: number | null;
  readonly lastT: number;
  /** Last fix that survived cleaning — the reference for duplicate and teleport rejection. */
  readonly lastKept: TrackFix | null;
  /** `toLegs`'s anchor, which deliberately does not advance below the jitter floor. */
  readonly anchor: TrackFix | null;
  readonly kept: number;
  readonly distanceM: number;
  readonly movingTimeS: number;
  readonly maxSpeedMps: number;
  readonly eleCount: number;
  readonly minEleM: number | null;
  readonly maxEleM: number | null;
  /** `computeGainLoss`'s hysteresis machine, caught mid-run. */
  readonly gainM: number;
  readonly lossM: number;
  readonly reference: number;
  readonly extreme: number;
  readonly direction: 0 | 1 | -1;
}

export function initialTrackStats(): TrackStatsState {
  return {
    firstT: null,
    lastT: 0,
    lastKept: null,
    anchor: null,
    kept: 0,
    distanceM: 0,
    movingTimeS: 0,
    maxSpeedMps: 0,
    eleCount: 0,
    minEleM: null,
    maxEleM: null,
    gainM: 0,
    lossM: 0,
    reference: 0,
    extreme: 0,
    direction: 0,
  };
}

/** One fix folded in, or the state unchanged where cleaning rejects it. Constant time and space. */
export function advanceTrackStats(state: TrackStatsState, fix: TrackFix): TrackStatsState {
  if (!Number.isFinite(fix.lng) || !Number.isFinite(fix.lat)) return state;
  if (fix.accuracyM != null && fix.accuracyM > MAX_FIX_ACCURACY_M) return state;

  const { lastKept } = state;
  if (lastKept) {
    if (fix.t <= lastKept.t) return state;
    const dt = fix.t - lastKept.t;
    const step = haversineM([lastKept.lng, lastKept.lat], [fix.lng, fix.lat]);
    // Rejecting a teleport rather than clamping keeps the next fix measured from somewhere real.
    if (dt > 0 && step / dt > MAX_PLAUSIBLE_SPEED_MPS) return state;
  }

  let { distanceM, movingTimeS, maxSpeedMps, anchor } = state;
  if (anchor === null) {
    anchor = fix;
  } else {
    const step = haversineM([anchor.lng, anchor.lat], [fix.lng, fix.lat]);
    const dtS = Math.max(0, fix.t - anchor.t);
    if (step >= MIN_STEP_M) {
      distanceM += step;
      if (dtS > 0 && step / dtS >= STOPPED_SPEED_MPS) {
        movingTimeS += dtS;
        maxSpeedMps = Math.max(maxSpeedMps, step / dtS);
      }
      anchor = fix;
    }
  }

  return {
    ...foldElevation(state, fix.eleM),
    firstT: state.firstT ?? fix.t,
    lastT: fix.t,
    lastKept: fix,
    kept: state.kept + 1,
    anchor,
    distanceM,
    movingTimeS,
    maxSpeedMps,
  };
}

/** The headline numbers as of now. Pure — the in-progress climb is banked without being consumed. */
export function accumulatedStats(state: TrackStatsState): ActivityStats {
  const empty: ActivityStats = {
    distanceM: 0,
    gainM: 0,
    lossM: 0,
    minEleM: null,
    maxEleM: null,
    movingTimeS: 0,
    elapsedTimeS: 0,
    avgSpeedMps: null,
    maxSpeedMps: null,
  };
  if (state.firstT === null) return empty;

  const elapsedTimeS = Math.max(0, state.lastT - state.firstT);
  // One fix is not a track: `summariseTrack` reports elapsed time and nothing else, and a lone
  // fix has no leg, no confirmed climb and no speed to report.
  if (state.kept === 1) return { ...empty, elapsedTimeS };

  let gainM = 0;
  let lossM = 0;
  if (state.eleCount >= 2) {
    gainM = state.gainM;
    lossM = state.lossM;
    if (state.direction === 1) gainM += state.extreme - state.reference;
    else if (state.direction === -1) lossM += state.reference - state.extreme;
  }

  const { distanceM, movingTimeS, maxSpeedMps } = state;
  return {
    distanceM: Math.round(distanceM),
    // `computeGainLoss` rounds to one decimal and `summariseTrack` then rounds to a whole metre.
    // The two do not commute at a half-metre, so they are applied in the same order here.
    gainM: Math.round(round1(gainM)),
    lossM: Math.round(round1(lossM)),
    minEleM: state.minEleM === null ? null : Math.round(state.minEleM),
    maxEleM: state.maxEleM === null ? null : Math.round(state.maxEleM),
    movingTimeS: Math.round(movingTimeS),
    elapsedTimeS,
    avgSpeedMps: movingTimeS > 0 ? round1((distanceM / movingTimeS) * 100) / 100 : null,
    maxSpeedMps: maxSpeedMps > 0 ? round1(maxSpeedMps * 100) / 100 : null,
  };
}

/** The elevation half of the fold: extent, and `computeGainLoss`'s hysteresis, one sample on. */
function foldElevation(state: TrackStatsState, eleM: number | null | undefined): TrackStatsState {
  if (eleM == null || !Number.isFinite(eleM)) return state;
  const ele = eleM;
  const eleCount = state.eleCount + 1;
  const minEleM = state.minEleM === null ? ele : Math.min(state.minEleM, ele);
  const maxEleM = state.maxEleM === null ? ele : Math.max(state.maxEleM, ele);
  if (state.eleCount === 0) {
    return { ...state, eleCount, minEleM, maxEleM, reference: ele, extreme: ele, direction: 0 };
  }

  let { gainM, lossM, reference, extreme, direction } = state;
  if (direction === 0) {
    if (ele - reference >= GAIN_THRESHOLD_M) {
      direction = 1;
      extreme = ele;
    } else if (reference - ele >= GAIN_THRESHOLD_M) {
      direction = -1;
      extreme = ele;
    }
  } else if (direction === 1) {
    if (ele > extreme) {
      extreme = ele;
    } else if (extreme - ele >= GAIN_THRESHOLD_M) {
      // Confirmed reversal: bank the climb and start tracking the descent.
      gainM += extreme - reference;
      reference = extreme;
      direction = -1;
      extreme = ele;
    }
  } else {
    if (ele < extreme) {
      extreme = ele;
    } else if (ele - extreme >= GAIN_THRESHOLD_M) {
      lossM += reference - extreme;
      reference = extreme;
      direction = 1;
      extreme = ele;
    }
  }
  return { ...state, eleCount, minEleM, maxEleM, gainM, lossM, reference, extreme, direction };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
