import { describe, expect, it } from 'vitest';
import {
  SHENANDOAH_METRIC_CONSTANT,
  TERRAIN_CAUTIONS,
  TERRAIN_CAUTION_COPY,
  classifyDifficulty,
  shenandoahScore,
  terrainCaution,
} from '@switchback/core';

const FT = 0.3048;
const MI = 1609.344;

describe('shenandoahScore', () => {
  /**
   * The metric constant is only trustworthy if it reproduces the ratings the National
   * Park Service publishes for its own trails from imperial inputs. These two are taken
   * straight from the NPS Shenandoah difficulty page.
   */
  it('reproduces the published NPS rating for Old Rag Mountain (213, "difficult")', () => {
    const score = shenandoahScore(2415 * FT, 9.4 * MI);
    expect(score).toBeCloseTo(213, 0);
  });

  it('reproduces the published NPS rating for Stony Man (33, "easiest")', () => {
    const score = shenandoahScore(340 * FT, 1.6 * MI);
    expect(score).toBeCloseTo(33, 0);
  });

  it('matches the imperial formula exactly for arbitrary inputs', () => {
    const gainM = 512;
    const lengthM = 7300;
    const imperial = Math.sqrt((gainM / FT) * 2 * (lengthM / MI));
    expect(shenandoahScore(gainM, lengthM)).toBeCloseTo(imperial, 6);
  });

  it('encodes the unit conversion in one constant', () => {
    expect(SHENANDOAH_METRIC_CONSTANT).toBeCloseTo((1 / FT) * 2 * (1000 / MI), 4);
  });

  it('is zero for degenerate input and never NaN', () => {
    expect(shenandoahScore(0, 0)).toBe(0);
    expect(shenandoahScore(-100, 5000)).toBe(0);
    expect(shenandoahScore(Number.NaN, 5000)).toBe(0);
  });
});

describe('classifyDifficulty bands', () => {
  // Solve for the exact gain that lands on a band edge at a fixed 5 km length, so the
  // boundary is tested rather than a value that happens to sit near it.
  const lengthM = 5000;
  const gainForScore = (score: number) =>
    (score * score) / (SHENANDOAH_METRIC_CONSTANT * (lengthM / 1000));

  it('is easy just below 50 and moderate exactly at 50', () => {
    expect(classifyDifficulty({ gainM: gainForScore(49.99), lengthM }).difficulty).toBe('easy');
    expect(classifyDifficulty({ gainM: gainForScore(50), lengthM }).difficulty).toBe('moderate');
  });

  it('is moderate just below 100 and hard exactly at 100', () => {
    expect(classifyDifficulty({ gainM: gainForScore(99.99), lengthM }).difficulty).toBe('moderate');
    expect(classifyDifficulty({ gainM: gainForScore(100), lengthM }).difficulty).toBe('hard');
  });
});

describe('classifyDifficulty adjustments', () => {
  /** The case the raw formula gets wrong: short, steep, technical. */
  const shortScramble = { gainM: 300, lengthM: 1500 };

  it('scores the short scramble as easy on the raw formula alone', () => {
    expect(shenandoahScore(shortScramble.gainM, shortScramble.lengthM)).toBeLessThan(50);
    expect(classifyDifficulty(shortScramble).difficulty).toBe('easy');
  });

  it('raises it to hard on alpine terrain, and says why', () => {
    const result = classifyDifficulty({ ...shortScramble, sacScale: 'alpine_hiking' });
    expect(result.difficulty).toBe('hard');
    expect(result.raisedBy).toContain('sac_scale');
  });

  it('raises it to moderate on a sustained 25% grade', () => {
    const result = classifyDifficulty({ ...shortScramble, maxSustainedGrade: 0.25 });
    expect(result.difficulty).toBe('moderate');
    expect(result.raisedBy).toContain('sustained_grade');
  });

  it('raises it to hard on a sustained 35% grade', () => {
    expect(classifyDifficulty({ ...shortScramble, maxSustainedGrade: 0.35 }).difficulty).toBe(
      'hard',
    );
  });

  it('never lowers a difficulty the raw score already earned', () => {
    // A long, punishing slog on trivial terrain stays hard.
    const result = classifyDifficulty({
      gainM: 1800,
      lengthM: 22_000,
      sacScale: 'hiking',
      maxSustainedGrade: 0.05,
    });
    expect(result.difficulty).toBe('hard');
    expect(result.raisedBy).toEqual([]);
  });

  it('leaves the raw score untouched by the adjustments', () => {
    const raw = classifyDifficulty(shortScramble).score;
    const adjusted = classifyDifficulty({ ...shortScramble, sacScale: 'alpine_hiking' }).score;
    expect(adjusted).toBe(raw);
  });
});

describe('terrainCaution', () => {
  it('says nothing about a steep but walkable path', () => {
    // 30% is a hard pull and still a path. A caution here would fire on half the catalogue
    // and stop being read, which is the only failure mode that matters for a warning.
    expect(terrainCaution(0.3)).toBeNull();
    expect(terrainCaution(0.69)).toBeNull();
  });

  it('calls 35 degrees a scramble', () => {
    expect(terrainCaution(0.7)).toBe('scramble');
    expect(terrainCaution(0.99)).toBe('scramble');
  });

  it('calls 45 degrees and above a climb', () => {
    expect(terrainCaution(1)).toBe('climbing');
    // Mount Assiniboine as the catalogue actually holds it: 6.9 km, 1,981 m of ascent and a
    // sustained 147%. Every figure correct; "Hard" alone describes a long day rather than an
    // alpine face, which is the gap this exists to close.
    expect(terrainCaution(1.474)).toBe('climbing');
  });

  it('says nothing when the elevation pass has not run', () => {
    expect(terrainCaution(null)).toBeNull();
    expect(terrainCaution(undefined)).toBeNull();
    expect(terrainCaution(Number.NaN)).toBeNull();
    expect(terrainCaution(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('is independent of the difficulty band', () => {
    // The two claims answer different questions: how big a day, and is it a hike at all. A
    // short gully scores "easy" on the Shenandoah formula and still wants your hands.
    const gully = { gainM: 300, lengthM: 1500, maxSustainedGrade: 0.8 };
    expect(shenandoahScore(gully.gainM, gully.lengthM)).toBeLessThan(50);
    expect(terrainCaution(gully.maxSustainedGrade)).toBe('scramble');
  });

  it('has copy for every caution it can return', () => {
    for (const caution of TERRAIN_CAUTIONS) {
      const copy = TERRAIN_CAUTION_COPY[caution];
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });
});
