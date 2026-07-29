import { describe, expect, it } from 'vitest';
import { tallyMarks } from '../src/tally';

/** Sum of every division's width, which must always fill the rule exactly. */
function span(marks: ReturnType<typeof tallyMarks>): number {
  return marks.reduce((total, mark) => total + (mark.end - mark.start), 0);
}

describe('tallyMarks', () => {
  it('draws nothing for an empty list', () => {
    expect(tallyMarks([])).toEqual([]);
  });

  it('gives a single trail the whole rule', () => {
    expect(tallyMarks([8_200])).toEqual([{ start: 0, end: 1, lengthM: 8_200 }]);
  });

  it('splits two equal trails down the middle', () => {
    const marks = tallyMarks([5_000, 5_000]);
    expect(marks[0]?.end).toBeCloseTo(0.5, 10);
    expect(marks[1]?.start).toBeCloseTo(0.5, 10);
  });

  it('keeps the caller order, because the rule indexes what is under it', () => {
    const marks = tallyMarks([1_000, 9_000, 3_000]);
    expect(marks.map((mark) => mark.lengthM)).toEqual([1_000, 9_000, 3_000]);
  });

  it('leaves no gaps and no overlaps', () => {
    const marks = tallyMarks([1_200, 400, 18_000, 6_500, 900]);
    expect(marks[0]?.start).toBe(0);
    expect(marks.at(-1)?.end).toBe(1);
    for (let i = 1; i < marks.length; i += 1) {
      expect(marks[i]?.start).toBe(marks[i - 1]?.end);
    }
    expect(span(marks)).toBeCloseTo(1, 10);
  });

  it('keeps a short hike visible beside a through-hike', () => {
    // 2 km against the PCT is 1 part in 2,000 — invisible without the floor.
    const marks = tallyMarks([2_000, 4_270_000], { minWidth: 0.01 });
    expect(marks[0]?.end).toBeGreaterThanOrEqual(0.01);
  });

  it('still fills the rule once the floor has to yield to the count', () => {
    // 400 divisions cannot each hold 0.8% of the rule; the floor gives way, not the total.
    const marks = tallyMarks(Array.from({ length: 400 }, (_, i) => 1_000 + i));
    expect(marks).toHaveLength(400);
    expect(marks.every((mark) => mark.end > mark.start)).toBe(true);
    expect(marks.at(-1)?.end).toBe(1);
  });

  it('drops lengths that are not a real distance', () => {
    const marks = tallyMarks([5_000, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5_000]);
    expect(marks).toHaveLength(2);
    expect(marks.at(-1)?.end).toBe(1);
  });

  it('draws nothing when every length is unusable', () => {
    expect(tallyMarks([0, -4, Number.NaN])).toEqual([]);
  });
});
