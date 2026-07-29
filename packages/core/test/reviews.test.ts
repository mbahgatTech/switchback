import { describe, expect, it } from 'vitest';
import {
  REVIEW_BODY_MAX,
  TRAIL_CONDITIONS,
  averageRating,
  hikedOnSchema,
  isoDateSchema,
  normaliseConditions,
  reviewWriteSchema,
} from '@switchback/core';

/**
 * The review vocabulary and the two calculations that sit under it.
 *
 * Reviews are the one part of this product that cannot be recomputed from the map. A wrong
 * gain figure is fixed by re-running a pass; a review section that reorders someone's chips,
 * rounds their rating differently in two places, or rejects the date they actually hiked is
 * a misrepresentation of what a person said, and no later pass repairs it.
 */

/** UTC today, shifted by whole days, as `YYYY-MM-DD` — the same arithmetic the schema uses. */
function utcDay(days = 0): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('normaliseConditions', () => {
  it('sorts into the vocabulary order rather than the order they were tapped', () => {
    // The point of the whole function. Two reports saying the same three things must print
    // the same three chips in the same three positions, so that reading down a column of
    // reports looking for "icy" is scanning, not a word search.
    expect(normaliseConditions(['crowded', 'icy', 'dry'])).toEqual(['dry', 'icy', 'crowded']);
    expect(normaliseConditions(['dry', 'icy', 'crowded'])).toEqual(['dry', 'icy', 'crowded']);
  });

  it('dedupes', () => {
    expect(normaliseConditions(['muddy', 'muddy', 'muddy'])).toEqual(['muddy']);
  });

  it('drops anything outside the vocabulary', () => {
    // This also runs over rows read back from the database, where a value retired from the
    // enum — or written by some future admin path — would otherwise reach a label lookup
    // that has no entry for it and render `undefined` on the page.
    expect(normaliseConditions(['muddy', 'sharks', ''])).toEqual(['muddy']);
  });

  it('returns nothing for nothing', () => {
    expect(normaliseConditions([])).toEqual([]);
  });

  it('is stable: normalising twice is normalising once', () => {
    const once = normaliseConditions(['poorly_marked', 'snow', 'bugs']);
    expect(normaliseConditions(once)).toEqual(once);
  });
});

describe('averageRating', () => {
  it('is null, not zero, when nobody has reviewed it', () => {
    // A trail nobody has hiked and a trail everybody hated are not the same trail, and a
    // card that prints 0.0 for the first one is stating something no reviewer ever said.
    expect(averageRating([0, 0, 0, 0, 0])).toBeNull();
    expect(averageRating([])).toBeNull();
  });

  it('indexes counts by rating − 1', () => {
    // counts[0] is the one-star bucket. Off by one here and every average on the site is
    // wrong by a whole point in a way that still looks plausible.
    expect(averageRating([1, 0, 0, 0, 0])).toBe(1);
    expect(averageRating([0, 0, 0, 0, 1])).toBe(5);
  });

  it('rounds to one decimal', () => {
    // 4.666… on three reviews. A second decimal would claim to separate 4.66 from 4.67 on a
    // sample of three, which the sample cannot support.
    expect(averageRating([0, 0, 0, 1, 2])).toBe(4.7);
    expect(averageRating([0, 0, 1, 1, 1])).toBe(4);
  });

  it('averages the reviews rather than the buckets', () => {
    // Nine loved it, one did not: 4.6, not the 3.0 a mean over the five bucket labels gives.
    expect(averageRating([1, 0, 0, 0, 9])).toBe(4.6);
  });
});

describe('isoDateSchema', () => {
  it('rejects a date that does not exist', () => {
    // `new Date('2026-02-31')` rolls forward to 3 March rather than failing, so the round
    // trip is the only check that catches this.
    expect(isoDateSchema.safeParse('2026-02-31').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-13-01').success).toBe(false);
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(isoDateSchema.safeParse('2024-02-29').success).toBe(true);
    expect(isoDateSchema.safeParse('2026-02-29').success).toBe(false);
  });

  it('insists on the padded form', () => {
    // `2026-3-14` parses fine as a Date and sorts wrong as a string, which is the failure
    // mode: it only shows up once there are enough rows for the ordering to matter.
    expect(isoDateSchema.safeParse('2026-3-14').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-03-14T00:00:00Z').success).toBe(false);
  });
});

describe('hikedOnSchema', () => {
  it('accepts an ordinary past date', () => {
    expect(hikedOnSchema.safeParse('2026-03-14').success).toBe(true);
  });

  it('gives a day of slack, so Auckland can file today', () => {
    // "Today" in Auckland is tomorrow in UTC for most of the working day. Rejecting a
    // hiker's own date because our clock is behind theirs is a bug only ever reported by
    // the people furthest from us.
    expect(hikedOnSchema.safeParse(utcDay(0)).success).toBe(true);
    expect(hikedOnSchema.safeParse(utcDay(1)).success).toBe(true);
  });

  it('refuses a report of a hike that has not happened', () => {
    expect(hikedOnSchema.safeParse(utcDay(2)).success).toBe(false);
    expect(hikedOnSchema.safeParse(utcDay(400)).success).toBe(false);
  });

  it('refuses a year that is a typo rather than a date', () => {
    // The regex is happy with `0202-07-14`; a mistyped year that sorts eighteen centuries
    // early is worse than no date at all.
    expect(hikedOnSchema.safeParse('0202-07-14').success).toBe(false);
    expect(hikedOnSchema.safeParse('1969-12-31').success).toBe(false);
    expect(hikedOnSchema.safeParse('1970-01-01').success).toBe(true);
  });
});

describe('reviewWriteSchema', () => {
  const MINIMAL = { trailId: 'trl_1', rating: 4 };

  it('takes a rating on its own', () => {
    // A rating with no prose is a legitimate review. Requiring a body invents one.
    const parsed = reviewWriteSchema.parse(MINIMAL);
    expect(parsed.rating).toBe(4);
    expect(parsed.conditions).toEqual([]);
  });

  it('holds the rating to whole stars from one to five', () => {
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, rating: 0 }).success).toBe(false);
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, rating: 6 }).success).toBe(false);
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, rating: 4.5 }).success).toBe(false);
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, rating: 1 }).success).toBe(true);
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, rating: 5 }).success).toBe(true);
  });

  it('trims the body before measuring it', () => {
    const parsed = reviewWriteSchema.parse({ ...MINIMAL, body: '  Boggy under the col.  ' });
    expect(parsed.body).toBe('Boggy under the col.');
  });

  it('caps the body at a length no page has to paginate', () => {
    expect(
      reviewWriteSchema.safeParse({ ...MINIMAL, body: 'x'.repeat(REVIEW_BODY_MAX) }).success,
    ).toBe(true);
    expect(
      reviewWriteSchema.safeParse({ ...MINIMAL, body: 'x'.repeat(REVIEW_BODY_MAX + 1) }).success,
    ).toBe(false);
  });

  it('canonicalises the conditions on the way in', () => {
    // Same transform as the read path, so a chip rail cannot reshuffle between the review
    // someone just wrote and the same review read back on the next page load.
    const parsed = reviewWriteSchema.parse({
      ...MINIMAL,
      conditions: ['crowded', 'muddy', 'muddy', 'icy'],
    });
    expect(parsed.conditions).toEqual(['muddy', 'icy', 'crowded']);
  });

  it('refuses a condition outside the vocabulary rather than dropping it silently', () => {
    // Read-side normalisation drops unknowns because old rows are not the writer's fault.
    // A live client sending one is a bug, and a 400 is how it gets found.
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, conditions: ['sharks'] }).success).toBe(false);
  });

  it('cannot be sent more conditions than exist', () => {
    const tooMany = [...TRAIL_CONDITIONS, ...TRAIL_CONDITIONS];
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, conditions: tooMany }).success).toBe(false);
  });

  it('passes the hiked-on date through the calendar check', () => {
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, hikedOn: '2026-02-31' }).success).toBe(false);
    expect(reviewWriteSchema.parse({ ...MINIMAL, hikedOn: null }).hikedOn).toBeNull();
  });

  it('takes an activity type or none', () => {
    expect(
      reviewWriteSchema.parse({ ...MINIMAL, activityType: 'trail_running' }).activityType,
    ).toBe('trail_running');
    expect(reviewWriteSchema.safeParse({ ...MINIMAL, activityType: 'paragliding' }).success).toBe(
      false,
    );
  });
});
