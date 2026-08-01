import { describe, expect, it } from 'vitest';
import type { ElevationPoint, LngLat } from '@switchback/core';
import {
  GAIN_THRESHOLD_M,
  buildProfile,
  computeGainLoss,
  computeTrailStats,
  despike,
  hikedProfile,
  highPointIndex,
  maxSustainedGrade,
  mirrorProfile,
} from '@switchback/geo';
import { lineNorth } from './helpers';

/** A profile with a given spacing and an elevation function of distance. */
function profileOf(spacingM: number, count: number, eleAt: (distM: number) => number) {
  return Array.from({ length: count }, (_, i) => ({
    distM: i * spacingM,
    eleM: eleAt(i * spacingM),
    lng: 0,
    lat: 45,
  })) satisfies ElevationPoint[];
}

describe('computeGainLoss', () => {
  it('credits a clean ascent in full', () => {
    const climb = Array.from({ length: 11 }, (_, i) => i * 10); // 0 → 100 m
    expect(computeGainLoss(climb)).toEqual({ gainM: 100, lossM: 0 });
  });

  it('credits an out-and-back symmetrically', () => {
    const up = Array.from({ length: 11 }, (_, i) => i * 10);
    const there = [...up, ...up.slice(0, -1).reverse()];
    expect(computeGainLoss(there)).toEqual({ gainM: 100, lossM: 100 });
  });

  it('suppresses DEM noise — the flat lakeside path that reports 400 m of climb', () => {
    // ±3 m jitter, 400 samples: naive summing would accumulate hundreds of metres.
    const noisy = Array.from({ length: 400 }, (_, i) => 250 + Math.sin(i) * 3);
    const naive = noisy.reduce(
      (sum, e, i) => (i === 0 ? 0 : sum + Math.max(0, e - noisy[i - 1]!)),
      0,
    );
    expect(naive).toBeGreaterThan(300); // the artefact this filter exists to remove
    expect(computeGainLoss(noisy)).toEqual({ gainM: 0, lossM: 0 });
  });

  it('credits a climb that pauses and resumes in full, not in re-thresholded pieces', () => {
    // 0 → 20, dip to 15 (below threshold, so noise), on to 40.
    expect(computeGainLoss([0, 20, 15, 40]).gainM).toBe(40);
  });

  it('banks a real reversal once it exceeds the threshold', () => {
    // 0 → 40, down to 25 (a 15 m drop, above threshold), back to 60.
    const { gainM, lossM } = computeGainLoss([0, 40, 25, 60]);
    expect(gainM).toBe(40 + 35);
    expect(lossM).toBe(15);
  });

  it('ignores an excursion smaller than the threshold', () => {
    const under = [100, 100 + GAIN_THRESHOLD_M - 0.1, 100];
    expect(computeGainLoss(under)).toEqual({ gainM: 0, lossM: 0 });
  });

  it('honours an explicit threshold', () => {
    const bumps = [0, 5, 0, 5, 0, 5];
    expect(computeGainLoss(bumps, 10).gainM).toBe(0);
    expect(computeGainLoss(bumps, 2).gainM).toBeGreaterThan(0);
  });

  it('skips non-finite samples rather than propagating NaN', () => {
    const withHole = [0, 20, Number.NaN, 40];
    expect(computeGainLoss(withHole).gainM).toBe(40);
  });

  it('is zero for a profile too short to have a slope', () => {
    expect(computeGainLoss([])).toEqual({ gainM: 0, lossM: 0 });
    expect(computeGainLoss([500])).toEqual({ gainM: 0, lossM: 0 });
  });
});

describe('maxSustainedGrade', () => {
  it('measures a constant grade exactly', () => {
    expect(maxSustainedGrade(profileOf(25, 21, (d) => d * 0.2))).toBeCloseTo(0.2, 3);
  });

  it('is zero on the flat', () => {
    expect(maxSustainedGrade(profileOf(25, 21, () => 400))).toBe(0);
  });

  it('finds the steepest window, not the average', () => {
    // 500 m flat, then 200 m at 30%.
    const p = profileOf(25, 29, (d) => (d <= 500 ? 0 : (d - 500) * 0.3));
    expect(maxSustainedGrade(p)).toBeCloseTo(0.3, 2);
  });

  it('does not let a single noisy sample imply a 40% grade', () => {
    // One 25 m step up in an otherwise flat 1 km — a 100% grade between neighbours,
    // but only 2.5% averaged over the measurement window.
    const p = profileOf(25, 41, (d) => (d >= 500 ? 25 : 0));
    expect(maxSustainedGrade(p)).toBeLessThan(0.3);
  });

  it('is null for a line shorter than the measurement window', () => {
    expect(maxSustainedGrade(profileOf(10, 5, (d) => d))).toBeNull();
    expect(maxSustainedGrade([])).toBeNull();
  });

  it('reports descent steepness too — an unsigned magnitude', () => {
    expect(maxSustainedGrade(profileOf(25, 21, (d) => 500 - d * 0.2))).toBeCloseTo(0.2, 3);
  });

  it('measures a spacing that does not divide the window', () => {
    // Regression: `resampleLine` spreads its remainder, so a nominal 25 m lands at 25.2 or
    // 25.066, and the window tail used to advance past every head — 0% on one climbing trail
    // in eight, while the ones spaced a hair under 25 m read correctly.
    for (const spacing of [25.2, 25.066, 25.123, 24.9, 33.4, 51]) {
      const grade = maxSustainedGrade(profileOf(spacing, 41, (d) => d * 0.24));
      expect(grade, `${spacing} m spacing`).toBeCloseTo(0.24, 2);
    }
  });

  it('measures over the window nearest 100 m, from either side of it', () => {
    // A 300 m pitch at 30% with 200 m of flat each side: under 30% means the window stretched
    // past the steep ground, over it means the window collapsed onto one noisy step.
    for (const spacing of [24.9, 25, 25.2, 26.5]) {
      const p = profileOf(spacing, 29, (d) => Math.min(Math.max(d - 200, 0), 300) * 0.3);
      expect(maxSustainedGrade(p), `${spacing} m spacing`).toBeCloseTo(0.3, 1);
    }
  });
});

describe('despike', () => {
  /** Evenly spaced distances for a run of samples, so a case only has to state elevations. */
  const at = (n: number, spacingM = 25) => Array.from({ length: n }, (_, i) => i * spacingM);

  it('drops the pixel that put 975 m of climb on a beach', () => {
    // North Kalaloch Beach, verbatim: a coastal line strays over water for one sample and
    // terrarium answers with bathymetry, which is real data and completely wrong here.
    const eles = [3, 0.5, 1.1, 5.2, -958.7, -4.8, 6.2, 9.9];
    const cleaned = despike(eles, at(eles.length));

    expect(cleaned[4]).toBeNull();
    expect(cleaned.filter((e) => e === null)).toHaveLength(1);

    // And once the gap is bridged, the walk along the sand stops climbing a kilometre.
    const built = buildProfile(lineNorth([0, 45], 175, eles.length), eles);
    expect(computeGainLoss(eles).gainM).toBeGreaterThan(900);
    expect(computeTrailStats(built).gainM).toBeLessThan(20);
    expect(computeTrailStats(built).minEleM).toBeGreaterThan(-10);
  });

  it('leaves a cliff alone, because a climb is not a spike', () => {
    // Finney Peak's steepest hundred metres: 148 m of rise in 100 m, an implausible-looking
    // 148% that the DEM says all the way along. No sample stands off its own chord.
    const eles = [1379, 1408.8, 1443.2, 1484.7, 1526.9, 1542.7];
    expect(despike(eles, at(eles.length))).toEqual(eles);
  });

  it('keeps a genuine step up, where the neighbours disagree with each other', () => {
    // A sample is only suspect when the samples either side of it agree and it does not.
    // Here they do not agree — the ground rises and stays risen — so nothing is a spike.
    expect(despike([100, 100, 400, 400], at(4))).toEqual([100, 100, 400, 400]);
  });

  it('scales with the sampling density instead of counting metres', () => {
    // A profile long enough to hit MAX_PROFILE_POINTS is resampled to hundreds of metres, not
    // 25, and a threshold in metres would be paranoid at one end and useless at the other.
    const eles = [1000, 1300, 1000];
    expect(despike(eles, at(3, 25))[1]).toBeNull(); // 300 m off the chord over 50 m
    expect(despike(eles, at(3, 500))).toEqual(eles); // the same 300 m over 1 km is a hill
  });

  it('leaves a steep sample alone when the ground is already that steep', () => {
    // Citadel Peak Route across its col: sample 4 stands 237% off the chord, past the deviation
    // bar, but the two references are already 190% apart — so a rough sample is in character.
    // Deleting the ratio condition gouges four samples out of a real col.
    const dist = [0, 22, 35, 59, 82, 103, 127, 152, 176];
    const eles = [2518.2, 2532.0, 2540.5, 2555.4, 2531.9, 2411.3, 2378.8, 2383.2, 2441.1];
    expect(despike(eles, dist)).toEqual(eles);
  });

  it('still catches a notch in a ridge, where the ground either side is steep but agrees', () => {
    // Isabelle Peak Route, the closest call in the corpus: a 148 m hole 45 m wide in a ridge
    // whose references agree to within 27%. Citadel above passes because its references
    // disagree by 190%; here they do not.
    const dist = [0, 23, 41, 62, 85, 107, 132, 150];
    const eles = [2873.0, 2884.4, 2883.8, 2843.5, 2747.2, 2901.6, 2898.0, 2902.5];
    expect(despike(eles, dist)).toEqual([
      2873.0,
      2884.4,
      2883.8,
      2843.5,
      null,
      2901.6,
      2898.0,
      2902.5,
    ]);
  });

  it('leaves the ends unjudged, and a bad end cannot take its neighbour with it', () => {
    // One sample never moves a median, so a bad end shifts no reference far enough to put the
    // real ground between them under suspicion.
    const eles = [-958.7, 5, 6, 7, -958.7];
    expect(despike(eles, at(5))).toEqual(eles);
  });

  it('catches a run of bad pixels, not just the first of them', () => {
    // A median over seven a side survives a run of three; a mean, or a window of three, would
    // take its bearing from the hole and excuse all of them.
    const cleaned = despike([5, 6, 7, -958.7, -958.7, 9, 10, 11], at(8));
    expect(cleaned).toEqual([5, 6, 7, null, null, 9, 10, 11]);
  });

  it('erodes a run long enough to outvote a single reference', () => {
    // Kalaloch Beaches at a creek mouth: six consecutive samples of sea floor. A run this long
    // hides its own ends — the middle sample outvotes a median over five, that reference
    // reports the hole as ground, and the cliff gate waves the whole run through in one pass.
    const dist = [0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300];
    const eles = [5.9, 5, 5, -567.2, -1175.2, -1546.8, -2027.1, -1291.7, -556.6, 6.7, 5.7, 7, 7.5];
    expect(despike(eles, dist)).toEqual([
      5.9,
      5,
      5,
      null,
      null,
      null,
      null,
      null,
      null,
      6.7,
      5.7,
      7,
      7.5,
    ]);
  });

  it('passes gaps and short runs through untouched', () => {
    expect(despike([5, null, 7], at(3))).toEqual([5, null, 7]);
    expect(despike([5, 7], at(2))).toEqual([5, 7]);
    expect(despike([], [])).toEqual([]);
  });

  it('is applied by buildProfile, which is where every stored profile comes from', () => {
    const coords: LngLat[] = lineNorth([0, 45], 400, 5);
    const p = buildProfile(coords, [10, 12, -958.7, 16, 18]);
    // Bridged, not merely dropped: the profile keeps all five samples and stays smooth.
    expect(p).toHaveLength(5);
    expect(p[2]!.eleM).toBeCloseTo(14, 0);
  });
});

describe('buildProfile', () => {
  const coords: LngLat[] = lineNorth([0, 45], 1000, 5);

  it('aligns cumulative distance with the geometry', () => {
    const p = buildProfile(coords, [0, 25, 50, 75, 100]);
    expect(p).toHaveLength(5);
    expect(p[0]!.distM).toBe(0);
    expect(p[4]!.distM).toBeCloseTo(1000, 0);
    expect(p[2]!.eleM).toBe(50);
    expect(p[2]!.lng).toBe(coords[2]![0]);
    expect(p[2]!.lat).toBe(coords[2]![1]);
  });

  it('interpolates across a tile that failed to fetch', () => {
    const p = buildProfile(coords, [0, null, null, null, 100]);
    expect(p.map((x) => x.eleM)).toEqual([0, 25, 50, 75, 100]);
  });

  it('extends the nearest known value past a gap at either end', () => {
    const p = buildProfile(coords, [null, null, 50, 60, null]);
    expect(p.map((x) => x.eleM)).toEqual([50, 50, 50, 60, 60]);
  });

  it('falls back to zero when no elevation resolved at all', () => {
    const p = buildProfile(coords, [null, null, null, null, null]);
    expect(p.map((x) => x.eleM)).toEqual([0, 0, 0, 0, 0]);
  });

  it('refuses misaligned inputs loudly rather than silently truncating', () => {
    expect(() => buildProfile(coords, [0, 10])).toThrow(/length mismatch/);
  });
});

describe('computeTrailStats', () => {
  it('derives every card statistic in one pass', () => {
    // 2 km climbing steadily from 1,000 m to 1,300 m.
    const p = profileOf(25, 81, (d) => 1000 + d * 0.15);
    const stats = computeTrailStats(p);
    expect(stats.lengthM).toBe(2000);
    expect(stats.gainM).toBeCloseTo(300, 0);
    expect(stats.lossM).toBe(0);
    expect(stats.minEleM).toBe(1000);
    expect(stats.maxEleM).toBe(1300);
    expect(stats.maxSustainedGrade).toBeCloseTo(0.15, 2);
    expect(stats.estimatedTimeS).toBeGreaterThan(0);
  });

  it('slows the estimate on rough terrain without touching the geometry', () => {
    const p = profileOf(25, 81, (d) => 1000 + d * 0.15);
    const base = computeTrailStats(p);
    const rough = computeTrailStats(p, { terrainFactor: 0.5 });
    expect(rough.estimatedTimeS).toBeCloseTo(base.estimatedTimeS * 2, -1);
    expect(rough.lengthM).toBe(base.lengthM);
    expect(rough.gainM).toBe(base.gainM);
  });

  it('returns zeroes for an empty profile rather than NaN or Infinity', () => {
    const stats = computeTrailStats([]);
    expect(stats).toEqual({
      lengthM: 0,
      gainM: 0,
      lossM: 0,
      minEleM: 0,
      maxEleM: 0,
      maxSustainedGrade: null,
      estimatedTimeS: 0,
    });
  });
});

describe('highPointIndex', () => {
  it('finds the summit — the sample the weather forecast must always include', () => {
    const p = profileOf(100, 11, (d) => 500 + (d <= 600 ? d : 1200 - d));
    expect(highPointIndex(p)).toBe(6);
  });

  it('returns the first index for a flat profile', () => {
    expect(highPointIndex(profileOf(100, 5, () => 500))).toBe(0);
  });

  it('returns 0 for an empty profile', () => {
    expect(highPointIndex([])).toBe(0);
  });
});

/** A 400 m spur climbing 100 m to a dead end — five samples, the shape of a mapped-once trail. */
const SPUR = profileOf(100, 5, (d) => 200 + d * 0.25);

describe('mirrorProfile', () => {
  it('walks back down without standing on the turnaround twice', () => {
    const there = mirrorProfile(SPUR);

    expect(there.map((p) => p.distM)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800]);
    expect(there.filter((p) => p.distM === 400)).toHaveLength(1);
    expect(there.map((p) => p.eleM)).toEqual([200, 225, 250, 275, 300, 275, 250, 225, 200]);
  });

  it('gets the statistics a doubling would get wrong', () => {
    // Doubling loses the return leg's 100 m of descent, a figure readers judge their knees by.
    const stats = computeTrailStats(mirrorProfile(SPUR));
    const outward = computeTrailStats(SPUR);

    expect(stats.lengthM).toBe(2 * outward.lengthM);
    expect(outward.lossM).toBe(0);
    expect(stats.lossM).toBeCloseTo(100, 0);
    expect(stats.gainM).toBeCloseTo(outward.gainM, 0);
    expect(stats.estimatedTimeS).toBeLessThan(2 * outward.estimatedTimeS);
  });

  it('brings the coordinates home', () => {
    const zigzag = SPUR.map((p, i) => ({ ...p, lng: i * 0.001, lat: 45 + i * 0.002 }));
    const there = mirrorProfile(zigzag);
    expect(there[8]).toMatchObject({ lng: zigzag[0]!.lng, lat: zigzag[0]!.lat });
    expect(there[5]).toMatchObject({ lng: zigzag[3]!.lng, lat: zigzag[3]!.lat });
  });

  it('copies rather than aliases, so a caller cannot edit the stored profile', () => {
    const there = mirrorProfile(SPUR);
    there[0]!.eleM = -999;
    there[8]!.eleM = -999;
    expect(SPUR[0]!.eleM).toBe(200);
    expect(SPUR.map((p) => p.eleM)).toEqual([200, 225, 250, 275, 300]);
  });

  it('has nothing to mirror below two samples', () => {
    expect(mirrorProfile([])).toEqual([]);
    expect(mirrorProfile(SPUR.slice(0, 1))).toHaveLength(1);
  });
});

describe('hikedProfile', () => {
  it('completes an out-and-back whose stored line is one leg', () => {
    // What ingest actually writes: 400 m of geometry under a published 800 m round trip.
    const hiked = hikedProfile(SPUR, { routeType: 'out_and_back', lengthM: 800 });
    expect(hiked).toHaveLength(9);
    expect(hiked[hiked.length - 1]!.distM).toBe(800);
  });

  it('leaves an out-and-back whose stored line already retraces itself', () => {
    // 132 trails are this kind: classified out-and-back *from* their own retracing, so both
    // legs are already in the geometry.
    const hiked = hikedProfile(SPUR, { routeType: 'out_and_back', lengthM: 400 });
    expect(hiked).toHaveLength(5);
    expect(hiked[hiked.length - 1]!.distM).toBe(400);
  });

  it('decides by which reading the published length agrees with, not by a threshold', () => {
    const legs = (lengthM: number) =>
      hikedProfile(SPUR, { routeType: 'out_and_back', lengthM }).length;

    // The switch is at 600 m, where 2 × 400 and 400 are equidistant. Ties refuse.
    expect(legs(599)).toBe(5);
    expect(legs(600)).toBe(5);
    expect(legs(601)).toBe(9);
  });

  it('leaves loops and point-to-points alone whatever the length says', () => {
    for (const routeType of ['loop', 'point_to_point'] as const) {
      expect(hikedProfile(SPUR, { routeType, lengthM: 800 })).toHaveLength(5);
    }
  });

  it('refuses rather than guesses when the length is missing or nonsense', () => {
    // A comparison against NaN is false, so the rule falls through to leaving the profile be.
    expect(hikedProfile(SPUR, { routeType: 'out_and_back', lengthM: Number.NaN })).toHaveLength(5);
    expect(hikedProfile(SPUR, { routeType: 'out_and_back', lengthM: 0 })).toHaveLength(5);
  });

  it('is safe on a profile too short to have two ends', () => {
    expect(hikedProfile([], { routeType: 'out_and_back', lengthM: 800 })).toEqual([]);
    expect(
      hikedProfile(SPUR.slice(0, 1), { routeType: 'out_and_back', lengthM: 800 }),
    ).toHaveLength(1);
  });

  it('copies on the pass-through path too, not only when it mirrors', () => {
    const hiked = hikedProfile(SPUR, { routeType: 'loop', lengthM: 400 });
    hiked[0]!.eleM = -999;
    expect(SPUR[0]!.eleM).toBe(200);
  });

  it('puts the axis and the stat block on the same number', () => {
    // Regression: the Llanberis Path drew 5,987 m of stored geometry under a table quoting the
    // published 11,974 m.
    const stored = profileOf(25, 240, (d) => 100 + d * 0.18);
    const publishedM = 2 * stored[stored.length - 1]!.distM;

    const hiked = hikedProfile(stored, { routeType: 'out_and_back', lengthM: publishedM });
    expect(hiked[hiked.length - 1]!.distM).toBe(publishedM);
    expect(computeTrailStats(hiked).lengthM).toBe(publishedM);
  });
});
