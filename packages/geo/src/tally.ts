/**
 * The tally rule — a set of trails plotted as one traverse.
 *
 * A list of trails has exactly one number that says what kind of list it is, and it is not
 * the count. Six hikes totalling 12 km and six totalling 380 km are different projects, and
 * "6 trails" describes both. The rule draws the total as a single line and divides it at
 * each trail's length, so the shape of the list — one big day and five strolls, or six
 * matched outings — is legible before any of it is read.
 *
 * It is the margin scale of a printed sheet, reused: the same left-to-right distance axis
 * the section is plotted against, carrying a different quantity. That is deliberate. A list
 * and a trail are measured in the same unit and should be drawn in the same grammar.
 *
 * Pure, and in `@switchback/geo` rather than in a component, because the phone draws the
 * same rule with `react-native-svg` and two implementations of one graphic drift.
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
   * The narrowest a division may be drawn, as a fraction of the rule.
   *
   * Strict proportion would erase a 2 km stroll sitting beside a 4,270 km through-hike, and
   * an entry you cannot see is an entry the reader will not count. The floor is charged to
   * every division equally and the remainder is shared out in proportion, so the rule stays
   * an honest picture of the ratios everywhere it is not up against this limit.
   */
  minWidth?: number;
}

const DEFAULT_MIN_WIDTH = 0.008;

/**
 * Divide the rule.
 *
 * Order is the caller's — list position, or the day each hike happened — and is preserved,
 * because the rule doubles as the index of what is below it.
 *
 * Lengths that are missing, negative or not finite are dropped rather than clamped to zero:
 * a trail whose length never ingested has no share of a distance total, and drawing it as a
 * zero-width division would put a tick on the rule that no entry corresponds to.
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

  // Float drift over a few hundred divisions is enough to leave a hairline gap at the right
  // end of the rule, which reads as a missing entry rather than as arithmetic.
  const last = marks.at(-1);
  if (last) last.end = 1;
  return marks;
}
