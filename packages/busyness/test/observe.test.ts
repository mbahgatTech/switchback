import { describe, expect, it } from 'vitest';
import { SHRINKAGE_K, blendObservations, toGrid, type ObservationBucket } from '../src/observe';
import { DAYS_PER_WEEK, HOURS_PER_DAY } from '../src/prior';

function grid(fill: number): number[][] {
  return Array.from({ length: DAYS_PER_WEEK }, () => new Array<number>(HOURS_PER_DAY).fill(fill));
}

/** A prior that says Saturday evening, when the observations will say Saturday morning. */
function priorWithEveningPeak(): number[][] {
  const prior = grid(1);
  prior[6]![18] = 10;
  return prior;
}

const bucket = (
  dayOfWeek: number,
  hour: number,
  observed: number,
  sampleCount: number,
): ObservationBucket => ({ dayOfWeek, hour, observed, sampleCount });

describe('blendObservations', () => {
  it('returns the prior untouched when nothing has been recorded', () => {
    const prior = priorWithEveningPeak();
    const { surface, observationCount } = blendObservations(prior, []);
    expect(surface).toEqual(prior);
    expect(observationCount).toBe(0);
  });

  it('does not alias the prior it was given', () => {
    const prior = priorWithEveningPeak();
    const { surface } = blendObservations(prior, []);
    surface[0]![0] = 999;
    expect(prior[0]![0]).toBe(1);
  });

  it('lets a well-observed hour overrule the prior', () => {
    const prior = priorWithEveningPeak();
    const { surface } = blendObservations(prior, [
      bucket(6, 9, 50, 10_000),
      bucket(6, 18, 10, 10_000),
    ]);

    // Hundreds of recorded starts saying Saturday morning, against a prior that expected
    // the evening. The prior loses, which is the point of collecting them.
    expect(surface[6]![9]!).toBeGreaterThan(surface[6]![18]!);
    expect(surface[6]![9]!).toBeCloseTo(10, 1);
    expect(surface[6]![18]!).toBeCloseTo(2, 1);
  });

  it('moves halfway at the shrinkage constant, not all the way', () => {
    const prior = priorWithEveningPeak();
    const { surface } = blendObservations(prior, [bucket(2, 9, 50, SHRINKAGE_K)]);

    // observed 50 of a 50 peak, scaled into the prior's units by its peak of 10 → 10.
    // Half weight against a prior of 1 → 5.5.
    expect(surface[2]![9]!).toBeCloseTo(5.5, 6);
  });

  it('leaves hours nobody has recorded exactly as the prior had them', () => {
    // The reason the blend is per bucket. A trail with 400 recorded Saturday mornings and
    // no recorded Tuesdays must not have its Tuesday flattened to zero and called data.
    const prior = priorWithEveningPeak();
    const { surface } = blendObservations(prior, [bucket(6, 9, 50, 400)]);

    expect(surface[2]).toEqual(prior[2]);
    expect(surface[6]![18]!).toBe(10);
  });

  it('weights each hour by its own sample count', () => {
    const prior = priorWithEveningPeak();
    const { surface } = blendObservations(prior, [
      bucket(1, 8, 10, 1),
      bucket(1, 9, 10, 10),
      bucket(1, 10, 10, 1000),
    ]);

    expect(surface[1]![8]!).toBeLessThan(surface[1]![9]!);
    expect(surface[1]![9]!).toBeLessThan(surface[1]![10]!);
  });

  it('sums sample counts into the observation count', () => {
    const { observationCount } = blendObservations(grid(1), [
      bucket(0, 7, 3, 12),
      bucket(3, 17, 9, 30),
      bucket(6, 10, 40, 158),
    ]);
    expect(observationCount).toBe(200);
  });

  it('drops buckets that fall outside the week', () => {
    // A caller that counted Monday-first would otherwise write its Sunday into our Sunday
    // and be wrong without ever failing.
    const prior = grid(1);
    const { surface, observationCount } = blendObservations(prior, [
      bucket(7, 9, 50, 500),
      bucket(-1, 9, 50, 500),
      bucket(0, 24, 50, 500),
      bucket(0, 9.5, 50, 500),
    ]);

    expect(surface).toEqual(prior);
    expect(observationCount).toBe(0);
  });

  it('keeps the prior when every recorded value is zero', () => {
    const prior = priorWithEveningPeak();
    const { surface, observationCount } = blendObservations(prior, [bucket(6, 9, 0, 80)]);
    expect(surface).toEqual(prior);
    expect(observationCount).toBe(80);
  });
});

describe('toGrid', () => {
  it('fills a full 7×24 grid from a sparse list', () => {
    const filled = toGrid([bucket(3, 14, 7, 2)], (b) => b.observed);
    expect(filled).toHaveLength(DAYS_PER_WEEK);
    expect(filled[3]).toHaveLength(HOURS_PER_DAY);
    expect(filled[3]![14]).toBe(7);
    expect(filled[3]![13]).toBe(0);
  });

  it('clamps negatives to zero', () => {
    expect(toGrid([bucket(0, 0, -5, 1)], (b) => b.observed)[0]![0]).toBe(0);
  });
});
