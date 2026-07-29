import { describe, expect, it } from 'vitest';
import {
  bboxOverlaps,
  decodeCursor,
  encodeCursor,
  facetWhere,
  inRankOrder,
  orderFor,
} from '../src/routers/trails';

/**
 * The pure decisions behind the trails router.
 *
 * Everything here composes into a Prisma `where` or an `orderBy`, which means a mistake
 * does not throw — it silently returns the wrong trails, or the same trail on two pages.
 * That is the kind of bug only a test catches.
 */

describe('bboxOverlaps', () => {
  it('asks whether the boxes overlap, not whether one contains the other', () => {
    // Four inequalities, and each one is a `<=`/`>=` in the direction that admits a trail
    // hanging off the edge of the viewport. A containment test would drop every trail
    // longer than the screen — which is most of the interesting ones.
    expect(bboxOverlaps([-4.1, 53.0, -4.0, 53.1])).toEqual({
      AND: [
        { bboxS: { lte: 53.1 }, bboxN: { gte: 53.0 } },
        { bboxW: { lte: -4.0 }, bboxE: { gte: -4.1 } },
      ],
    });
  });

  it('splits a viewport that crosses the antimeridian into two spans', () => {
    // Panning west from Fiji gives west > east. Compared naively this is the empty set,
    // and the map goes blank exactly where the user is looking.
    const where = bboxOverlaps([179, -18, -179, -17]);
    const [vertical, horizontal] = (where.AND as Array<Record<string, unknown>>) ?? [];

    expect(vertical).toEqual({ bboxS: { lte: -17 }, bboxN: { gte: -18 } });
    expect(horizontal).toEqual({
      OR: [
        { bboxW: { lte: 180 }, bboxE: { gte: 179 } },
        { bboxW: { lte: -179 }, bboxE: { gte: -180 } },
      ],
    });
  });

  it('leaves an ordinary viewport unsplit', () => {
    const where = bboxOverlaps([-4.1, 53.0, -4.0, 53.1]);
    expect(JSON.stringify(where)).not.toContain('OR');
  });
});

describe('facetWhere', () => {
  it('adds nothing for an empty filter set', () => {
    expect(facetWhere({})).toEqual({});
    // Empty arrays are "the user cleared this filter", not "match nothing".
    expect(facetWhere({ difficulty: [], activityTypes: [] })).toEqual({});
  });

  it('matches a tagged value exactly, and never invents a negative', () => {
    // The tri-state that matters. A trail nobody has tagged for dogs is not a trail that
    // bans them, so `dogsAllowed: false` must not sweep up the untagged majority — and
    // leaving the facet unset must not filter at all.
    expect(facetWhere({ dogsAllowed: true }).dogsAllowed).toBe(true);
    expect(facetWhere({ dogsAllowed: false }).dogsAllowed).toBe(false);
    expect(facetWhere({}).dogsAllowed).toBeUndefined();
    expect(facetWhere({ wheelchairAccessible: false }).wheelchairAccessible).toBe(false);
  });

  it('builds one-sided ranges', () => {
    expect(facetWhere({ minLengthM: 5000 }).lengthM).toEqual({ gte: 5000, lte: undefined });
    expect(facetWhere({ maxGainM: 300 }).gainM).toEqual({ gte: undefined, lte: 300 });
    expect(facetWhere({ minLengthM: 1000, maxLengthM: 8000 }).lengthM).toEqual({
      gte: 1000,
      lte: 8000,
    });
  });

  it('treats activity types as "any of", not "all of"', () => {
    // A trail tagged hiking should surface for someone filtering hiking-or-trail-running.
    expect(facetWhere({ activityTypes: ['hiking', 'trail_running'] }).activityTypes).toEqual({
      hasSome: ['hiking', 'trail_running'],
    });
  });
});

describe('orderFor', () => {
  it('ends every ordering with a unique tiebreaker', () => {
    // Without this, two trails with equal popularity can swap between page 1 and page 2:
    // the reader sees one twice and never sees the other.
    const sorts = [
      'popularity',
      'rating',
      'length_asc',
      'length_desc',
      'gain_asc',
      'gain_desc',
    ] as const;

    for (const sort of sorts) {
      const order = orderFor(sort);
      expect(order[order.length - 1], sort).toEqual({ id: 'asc' });
    }
  });

  it('sorts unrated trails last rather than first', () => {
    // Postgres puts NULLs first on a DESC sort, which would head the "best rated" list
    // with every trail nobody has rated.
    expect(orderFor('rating')[0]).toEqual({ rating: { sort: 'desc', nulls: 'last' } });
  });

  it('falls back to popularity for orderings it cannot express', () => {
    // `relevance` and `distance_from_me` are ranked outside the database; reaching here
    // with one means the caller has already decided not to use the rank.
    expect(orderFor('relevance')[0]).toEqual({ popularity: 'desc' });
    expect(orderFor('distance_from_me')[0]).toEqual({ popularity: 'desc' });
  });
});

describe('inRankOrder', () => {
  const rows = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];

  it('restores the rank the database threw away', () => {
    // Postgres returns `WHERE id IN (...)` in whatever order it likes, so the relevance
    // ranking has to be re-applied here or the best match lands mid-page.
    expect(inRankOrder(rows, ['a', 'b', 'c'])).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('drops ranked ids the facets filtered out', () => {
    // The rank is computed before the facets narrow the set; a ranked id with no row is
    // a trail the user filtered away, not an error.
    expect(inRankOrder(rows, ['a', 'zzz', 'b'])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('drops rows missing from the rank rather than appending them', () => {
    expect(inRankOrder(rows, ['b'])).toEqual([{ id: 'b' }]);
    expect(inRankOrder(rows, [])).toEqual([]);
  });
});

describe('cursor', () => {
  it('round-trips an offset', () => {
    for (const offset of [0, 1, 120, 9999]) {
      expect(decodeCursor(encodeCursor(offset))).toBe(offset);
    }
  });

  it('is url-safe, because it travels in a query string', () => {
    // base64url, not base64: a `+` in a cursor becomes a space in transit and the next
    // page silently restarts at 0.
    expect(encodeCursor(123456789)).not.toMatch(/[+/=]/);
  });

  it('reads an absent cursor as the first page', () => {
    expect(decodeCursor(undefined)).toBe(0);
  });

  it('falls back to the first page rather than throwing on a bad cursor', () => {
    // A stale bookmark or a hand-edited URL. Page 1 is a kinder answer than a 400 in the
    // middle of an infinite scroll.
    expect(decodeCursor('not-base64!!')).toBe(0);
    expect(decodeCursor(Buffer.from('{"o":-5}').toString('base64url'))).toBe(0);
    expect(decodeCursor(Buffer.from('{"o":1.5}').toString('base64url'))).toBe(0);
    expect(decodeCursor(Buffer.from('{"o":"10"}').toString('base64url'))).toBe(0);
    expect(decodeCursor(Buffer.from('[]').toString('base64url'))).toBe(0);
  });
});
