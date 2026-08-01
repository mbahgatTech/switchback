import { describe, expect, it } from 'vitest';
import type { ActivityType, ReviewSort, TrailCondition } from '@switchback/core';
import { REVIEW_SORTS } from '@switchback/core';
import { ORDER_BY, toDateString, toReview, toUtcMidnight } from '../src/routers/reviews';

/**
 * The pure decisions behind the reviews router. None of these throw when they are wrong: a
 * missing tiebreak returns the same review on two pages, a date shaped in the server's zone
 * renders the day before someone's hike, and an `isMine` that defaults open puts an edit button
 * on a stranger's report.
 */

/**
 * One row as Prisma hands it over. The nullable fields are widened deliberately: as bare
 * literals TypeScript infers `string` and `Date`, and the `null` cases below would not
 * type-check.
 */
const BASE = {
  id: 'rev_1',
  trailId: 'trl_1',
  userId: 'usr_ivy',
  rating: 4,
  body: 'Boggy under the col, fine above it.' as string | null,
  hikedOn: new Date('2026-03-14T00:00:00Z') as Date | null,
  conditions: ['muddy', 'dry'] as TrailCondition[],
  activityType: 'hiking' as ActivityType | null,
  helpfulCount: 3,
  createdAt: new Date('2026-03-15T09:04:00Z'),
  updatedAt: new Date('2026-03-15T09:04:00Z'),
  /* Not hidden. The takedown path's own assertions live in `moderation.test.ts`. */
  hiddenAt: null as Date | null,
  user: {
    id: 'usr_ivy',
    username: 'ivy' as string | null,
    name: 'Ivy Calder' as string | null,
    image: null as string | null,
  },
  photos: [
    {
      id: 'pho_1',
      url: 'https://photos.example.test/t/trl_1/a.webp',
      thumbUrl: 'https://photos.example.test/t/trl_1/a-thumb.webp' as string | null,
      width: 1600 as number | null,
      height: 1200 as number | null,
      blurhash: 'L6PZfSjE.AyE_3t7t7R**0o#DgR4' as string | null,
      caption: null as string | null,
    },
  ],
};

function row(over: Partial<typeof BASE> = {}) {
  return { ...BASE, ...over };
}

describe('ORDER_BY', () => {
  it('breaks every tie all the way down to the id', () => {
    // Offset-based pages, and Postgres may return equal rows in any order between queries, so
    // a chain stopping at `rating` is quietly lossy.
    for (const sort of REVIEW_SORTS) {
      const chain = ORDER_BY[sort];
      expect(chain.length).toBeGreaterThan(1);
      expect(chain[chain.length - 1]).toEqual({ id: 'desc' });
    }
  });

  it('names each field once per chain', () => {
    // A repeated field is a chain that was edited rather than rewritten: the second mention is
    // dead, and the tiebreak everyone assumes is there is not.
    for (const sort of REVIEW_SORTS) {
      const fields = ORDER_BY[sort].flatMap((term) => Object.keys(term));
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  it('leads with the field the reader chose, past the tombstone term', () => {
    // See `TOMBSTONES_LAST` in the router: three sorts push the tombstones into a block first,
    // so "the field the reader chose" is the first term that is not that one.
    const chosen = (sort: ReviewSort) => {
      const [first, second] = ORDER_BY[sort];
      return 'hiddenAt' in first! ? second : first;
    };

    expect(chosen('recent')).toEqual({ createdAt: 'desc' });
    expect(chosen('rating_desc')).toEqual({ rating: 'desc' });
    expect(chosen('rating_asc')).toEqual({ rating: 'asc' });
    expect(chosen('helpful')).toEqual({ helpfulCount: 'desc' });
  });

  it('sinks the tombstones rather than floating them', () => {
    // `nulls: 'first'` puts the visible rows ahead of the removed ones. The other way round
    // would open every rating sort on a wall of takedowns.
    for (const sort of ['rating_desc', 'rating_asc', 'helpful'] as const) {
      expect(ORDER_BY[sort][0]).toEqual({ hiddenAt: { sort: 'desc', nulls: 'first' } });
    }

    // Not `recent`: it keys on a date the tombstone prints on its own face.
    expect(ORDER_BY.recent[0]).toEqual({ createdAt: 'desc' });
  });

  it('keeps the newest first within a rating, both ways up the scale', () => {
    // Lowest-rated exists so the closed bridge is findable; a three-year-old one-star at the
    // top of that list is the wrong report to lead with.
    expect(ORDER_BY.rating_asc[2]).toEqual({ createdAt: 'desc' });
    expect(ORDER_BY.rating_desc[2]).toEqual({ createdAt: 'desc' });
  });
});

describe('toDateString / toUtcMidnight', () => {
  it('round-trips a calendar date unchanged', () => {
    // `hikedOn` is a day someone was on a hill — no time, no zone — and formatting it in any
    // local zone turns "hiked it on the 3rd" into the 2nd for every reader west of Greenwich.
    for (const date of ['2026-03-14', '2026-01-01', '2026-12-31', '2024-02-29']) {
      expect(toDateString(toUtcMidnight(date))).toBe(date);
    }
  });

  it('writes midnight in UTC, not in whatever zone this machine sits in', () => {
    const instant = toUtcMidnight('2026-03-14');
    expect(instant.getUTCHours()).toBe(0);
    expect(instant.getUTCMinutes()).toBe(0);
    expect(instant.toISOString()).toBe('2026-03-14T00:00:00.000Z');
  });

  it('reads the date out of the instant, not out of the local clock', () => {
    // 23:30 UTC on the 14th is already the 15th in Sydney and still the 14th in Denver.
    expect(toDateString(new Date('2026-03-14T23:30:00Z'))).toBe('2026-03-14');
    expect(toDateString(new Date('2026-03-14T00:30:00Z'))).toBe('2026-03-14');
  });

  it('passes no date through as no date', () => {
    expect(toDateString(null)).toBeNull();
  });
});

describe('toReview', () => {
  it('renders the hiked-on date as the day it was stored as', () => {
    expect(toReview(row(), null).hikedOn).toBe('2026-03-14');
    expect(toReview(row({ hikedOn: null }), null).hikedOn).toBeNull();
  });

  it('re-canonicalises the conditions on the way out', () => {
    // Rows predating this router carry no guarantee of order, and two reports saying the same
    // three things must draw the same three chips in the same three positions.
    expect(toReview(row({ conditions: ['crowded', 'icy', 'dry'] }), null).conditions).toEqual([
      'dry',
      'icy',
      'crowded',
    ]);
  });

  it('claims a review for the caller only when the caller wrote it', () => {
    expect(toReview(row(), 'usr_ivy').isMine).toBe(true);
    expect(toReview(row(), 'usr_someone_else').isMine).toBe(false);
  });

  it('is false, never null, for a signed-out reader', () => {
    // `isMine` drives an edit affordance; a nullish value read as truthy downstream offers a
    // stranger the controls for someone else's report.
    expect(toReview(row(), null).isMine).toBe(false);
  });

  it('publishes the four public author fields and nothing else', () => {
    // The guard against the `include: { user: true }` that would put every column of the users
    // table on the wire. A field added to the select has to be added here on purpose.
    expect(Object.keys(toReview(row(), null).author).sort()).toEqual([
      'id',
      'image',
      'name',
      'username',
    ]);
  });

  it('never puts the author id where the review id goes', () => {
    // Both are strings and both are called `id` one level apart, which is the swap that
    // survives review and then makes React collapse every review by one author.
    const shaped = toReview(row(), null);
    expect(shaped.id).toBe('rev_1');
    expect(shaped.author.id).toBe('usr_ivy');
  });

  it('carries the timestamps through as dates, so the UI can spot an edit', () => {
    const edited = toReview(row({ updatedAt: new Date('2026-04-02T11:00:00Z') }), null);
    expect(edited.updatedAt.getTime() - edited.createdAt.getTime()).toBeGreaterThan(1000);
    expect(toReview(row(), null).updatedAt.getTime()).toBe(BASE.createdAt.getTime());
  });

  it('passes the photographs through, and only the seven fields a report frame needs', () => {
    // Deliberately thinner than the gallery's shape — no licence, attribution, distance or
    // ownership flag — because every one of these was taken by the person named above them.
    const [photo] = toReview(row(), null).photos;
    expect(Object.keys(photo ?? {}).sort()).toEqual([
      'blurhash',
      'caption',
      'height',
      'id',
      'thumbUrl',
      'url',
      'width',
    ]);
  });

  it('reports no photographs as an empty list rather than as nothing', () => {
    // The strip renders on `photos.length`; undefined would be a thrown read on every report
    // that carries no pictures, which is most of them.
    expect(toReview(row({ photos: [] }), null).photos).toEqual([]);
  });
});
