import { describe, expect, it } from 'vitest';
import type { TrackFix } from '@switchback/core';
import { accumulatedStats, advanceTrackStats, initialTrackStats } from '../src/track-stats';
import { summariseTrack } from '../src/track';

/**
 * The accumulator exists so a live recorder does not re-walk its own track once a second. It is
 * only worth having if it produces the same numbers as the full pass — a recorder showing one
 * distance while the server returns another is worse than a slow recorder.
 *
 * So the whole file is one claim, asserted over enough shapes to mean something: **fold equals
 * `summariseTrack`, for fixes in non-decreasing `t`.**
 */

function fold(fixes: readonly TrackFix[]) {
  let state = initialTrackStats();
  for (const fix of fixes) state = advanceTrackStats(state, fix);
  return accumulatedStats(state);
}

/** A deterministic generator, so a failure is reproducible from its seed alone. */
function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

/**
 * A track with everything `cleanFixes` and `computeGainLoss` have branches for: jitter under the
 * step floor, real movement, stops, occasional teleports, duplicate stamps, fixes too inaccurate
 * to keep, and gaps in elevation.
 */
function syntheticTrack(seed: number, length: number): TrackFix[] {
  const next = random(seed);
  const out: TrackFix[] = [];
  let lng = -121.49;
  let lat = 48.02;
  let ele = 610;
  let t = 0;
  for (let i = 0; i < length; i++) {
    const roll = next();
    if (roll < 0.08) {
      // Standing still: below the four-metre jitter floor.
      lng += (next() - 0.5) * 0.000_01;
    } else if (roll < 0.9) {
      lng += next() * 0.000_15;
      lat += (next() - 0.5) * 0.000_08;
      ele += (next() - 0.45) * 3;
    } else if (roll < 0.94) {
      // A canopy jump, which `cleanFixes` rejects outright.
      lng += 0.01;
    } else {
      ele += (next() - 0.5) * 40;
    }
    t += next() < 0.1 ? 0 : 1;
    out.push({
      t,
      lng,
      lat,
      eleM: next() < 0.15 ? null : ele,
      accuracyM: next() < 0.05 ? 400 : Math.round(next() * 20),
      speedMps: null,
    });
  }
  return out;
}

describe('the accumulator agrees with the full pass', () => {
  it('over 500 randomised tracks', () => {
    const disagreed: string[] = [];
    for (let seed = 1; seed <= 500; seed++) {
      const track = syntheticTrack(seed, 40 + (seed % 60));
      const folded = fold(track);
      const summarised = summariseTrack(track);
      if (JSON.stringify(folded) !== JSON.stringify(summarised)) {
        disagreed.push(`seed ${seed}: ${JSON.stringify(folded)} vs ${JSON.stringify(summarised)}`);
      }
    }
    expect(disagreed).toEqual([]);
  });

  it('on an empty track', () => {
    expect(fold([])).toEqual(summariseTrack([]));
  });

  it('on a single fix, where there is elapsed time and nothing else', () => {
    const one: TrackFix[] = [{ t: 12, lng: -121.4, lat: 48, eleM: 600, accuracyM: 5 }];
    expect(fold(one)).toEqual(summariseTrack(one));
  });

  it('on a track whose every fix is too inaccurate to keep', () => {
    const junk: TrackFix[] = [0, 1, 2].map((t) => ({
      t,
      lng: -121.4,
      lat: 48,
      eleM: 600,
      accuracyM: 900,
    }));
    expect(fold(junk)).toEqual(summariseTrack(junk));
  });

  it('on a track with no elevation at all', () => {
    const flat = syntheticTrack(7, 80).map((fix) => ({ ...fix, eleM: null }));
    expect(fold(flat)).toEqual(summariseTrack(flat));
  });

  it('on a climb that pauses and resumes, which the hysteresis credits in full', () => {
    const climb: TrackFix[] = [610, 618, 616, 630, 628, 645, 700, 690, 640].map((eleM, i) => ({
      t: i,
      lng: -121.49 + i * 0.000_2,
      lat: 48.02,
      eleM,
      accuracyM: 5,
    }));
    expect(fold(climb)).toEqual(summariseTrack(climb));
  });
});

describe('what the accumulator buys', () => {
  it('folds a full day at 1 Hz without re-walking the track', () => {
    const day = syntheticTrack(99, 20_000);
    const started = Date.now();
    let state = initialTrackStats();
    for (const fix of day) state = advanceTrackStats(state, fix);
    const elapsedMs = Date.now() - started;
    // A generous ceiling: the point is the shape of the curve, not this machine's constant.
    // `summariseTrack` called once per fix over the same track is minutes, not milliseconds.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(accumulatedStats(state)).toEqual(summariseTrack(day));
  });

  it('never spreads the elevation array, which has an argument-count ceiling', () => {
    const source = new URL('../src/track-stats.ts', import.meta.url);
    expect(source.pathname).toMatch(/track-stats/);
    // `Math.min(...elevations)` is what `summariseTrack` does and what a long hike overflows.
    expect(accumulatedStats(initialTrackStats()).minEleM).toBeNull();
  });
});
