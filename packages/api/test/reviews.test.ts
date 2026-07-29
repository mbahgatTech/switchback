import { describe, expect, it } from 'vitest';
import type { ActivityType, TrailCondition } from '@switchback/core';
import { REVIEW_SORTS } from '@switchback/core';
import { ORDER_BY, toDateString, toReview, toUtcMidnight } from '../src/routers/reviews';

/**
 * The pure decisions behind the reviews router.
 *
 * The same argument as `trails.test.ts`: none of this throws when it is wrong. A sort with a
 * missing tiebreak returns the same review on two pages, a date shaped in the server's zone
 * renders the day before someone's hike, and an `isMine` that defaults open puts an edit
 * button on a stranger's report. Every one of those is silent in production and loud here.
 */

/**
 * One row as Prisma hands it over.
 *
 * The nullable fields are widened deliberately: written as bare literals TypeScript infers
 * `string` and `Date`, and then the `null` cases below — which are the interesting ones —
 * would not type-check.
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
    // These pages are offset-based, and Postgres may return equal rows in any order it
    // likes between two queries. On a trail where forty people all gave four stars, a sort
    // that stops at `rating` can show the same review on page one and page two and drop
    // another entirely — a paginated list that is quietly lossy.
    for (const sort of REVIEW_SORTS) {
      const chain = ORDER_BY[sort];
      expect(chain.length).toBeGreaterThan(1);
      expect(chain[chain.length - 1]).toEqual({ id: 'desc' });
    }
  });

  it('names each field once per chain', () => {
    // A repeated field is a chain that was edited rather than rewritten: the second mention
    // is dead, and the tiebreak everyone assumes is there is not.
    for (const sort of REVIEW_SORTS) {
      const fields = ORDER_BY[sort].flatMap((term) => Object.keys(term));
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  it('leads with the field the reader chose', () => {
    expect(ORDER_BY.recent[0]).toEqual({ createdAt: 'desc' });
    expect(ORDER_BY.rating_desc[0]).toEqual({ rating: 'desc' });
    expect(ORDER_BY.rating_asc[0]).toEqual({ rating: 'asc' });
    expect(ORDER_BY.helpful[0]).toEqual({ helpfulCount: 'desc' });
  });

  it('keeps the newest first within a rating, both ways up the scale', () => {
    // Lowest-rated exists so the closed bridge and the washed-out ford are findable. A
    // three-year-old one-star at the top of that list is the wrong report to lead with.
    expect(ORDER_BY.rating_asc[1]).toEqual({ createdAt: 'desc' });
    expect(ORDER_BY.rating_desc[1]).toEqual({ createdAt: 'desc' });
  });
});

describe('toDateString / toUtcMidnight', () => {
  it('round-trips a calendar date unchanged', () => {
    // The whole contract. `hikedOn` is a day someone was on a hill — no time, no zone — and
    // it has to survive the trip through a `DateTime` column as the same three numbers they
    // typed. Formatting it in any local zone, including the server's, is what turns "hiked
    // it on the 3rd" into the 2nd for every reader west of Greenwich.
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
    // Slicing the ISO string is what makes the answer the same in both places.
    expect(toDateString(new Date('2026-03-14T23:30:00Z'))).toBe('2026-03-14');
    expect(toDateString(new Date('2026-03-14T00:30:00Z'))).toBe('2026-03-14');
  });

  it('passes no date through as no date', () => {
    // Plenty of reports say nothing about when. That is not the epoch.
    expect(toDateString(null)).toBeNull();
  });
});

describe('toReview', () => {
  it('renders the hiked-on date as the day it was stored as', () => {
    expect(toReview(row(), null).hikedOn).toBe('2026-03-14');
    expect(toReview(row({ hikedOn: null }), null).hikedOn).toBeNull();
  });

  it('re-canonicalises the conditions on the way out', () => {
    // Rows predating this router, or written by some future admin path, carry no guarantee
    // of order. Two reports saying the same three things must draw the same three chips in
    // the same three positions or the column stops being scannable.
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
    // `isMine` drives an edit affordance. A nullish value read as truthy anywhere downstream
    // offers a stranger the controls for someone else's report.
    expect(toReview(row(), null).isMine).toBe(false);
  });

  it('publishes the four public author fields and nothing else', () => {
    // The guard against the `include: { user: true }` that would put every column of the
    // users table on the wire — which is how email addresses leak from products that grew
    // quickly. If a field is added to the select, it has to be added here on purpose.
    expect(Object.keys(toReview(row(), null).author).sort()).toEqual([
      'id',
      'image',
      'name',
      'username',
    ]);
  });

  it('never puts the author id where the review id goes', () => {
    // Both are strings and both are called `id` one level apart, which is exactly the swap
    // that survives review and then makes React collapse every review by one author.
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
    // The report's photo shape is deliberately thinner than the gallery's — no licence, no
    // attribution, no distance along the route, no ownership flag — because every one of
    // these was taken by the person already named on the line above them. A field that
    // creeps back in here is nine redundant values on the wire per photograph per report.
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
    // The strip renders on `photos.length`. Undefined here would be a thrown read on every
    // report that carries no pictures, which is most of them.
    expect(toReview(row({ photos: [] }), null).photos).toEqual([]);
  });
});
