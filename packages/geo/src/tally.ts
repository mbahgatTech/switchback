/**
 * The tally rule: a set of trails plotted as one traverse, divided at each trail's length, so the
 * shape of a list is legible before any of it is read. Pure and here rather than in a component
 * because the phone draws the same rule with `react-native-svg`.
 */

/** One trail's share of the rule, as a fraction of the whole. */
export interface TallyMark {
  /** Left edge, 0–1 of the rule's width. */
  start: number;
  /** Right edge, 0–1. */
  end: number;
  /** The length this division stands for, unchanged — the label reads from here. */
  lengthM: number;
}

export interface TallyOptions {
  /**
   * The narrowest a division may be drawn, as a fraction of the rule — strict proportion would
   * erase a 2 km stroll beside a 4,270 km through-hike. Charged to every division equally, with
   * the remainder shared in proportion, so ratios stay honest away from the limit.
   */
  minWidth?: number;
}

const DEFAULT_MIN_WIDTH = 0.008;

/**
 * Divide the rule. Caller order is preserved, because the rule doubles as the index of what is
 * below it. Missing, negative or non-finite lengths are dropped rather than clamped to zero,
 * which would put a tick on the rule that no entry corresponds to.
 */
export function tallyMarks(lengths: readonly number[], options: TallyOptions = {}): TallyMark[] {
  const usable = lengths.filter((length) => Number.isFinite(length) && length > 0);
  if (usable.length === 0) return [];

  // n divisions cannot each be wider than 1/n, so the floor yields once the list is long.
  const floor = Math.min(options.minWidth ?? DEFAULT_MIN_WIDTH, 1 / usable.length);
  const proportional = 1 - floor * usable.length;
  const total = usable.reduce((sum, length) => sum + length, 0);

  const marks: TallyMark[] = [];
  let cursor = 0;
  for (const lengthM of usable) {
    cursor += floor + (lengthM / total) * proportional;
    marks.push({ start: marks.at(-1)?.end ?? 0, end: cursor, lengthM });
  }

  // Float drift over a few hundred divisions leaves a hairline gap at the right end of the
  // rule, which reads as a missing entry rather than as arithmetic.
  const last = marks.at(-1);
  if (last) last.end = 1;
  return marks;
}
