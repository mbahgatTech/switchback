import { describe, expect, it } from 'vitest';
import type { ListAggregate, ListRow } from '../src/routers/lists';
import { inDisplayOrder, toDateString, toSummaryShape } from '../src/routers/lists';

const OWNER = { id: 'u1', username: 'ffion', name: 'Ffion', image: null };

function list(over: Partial<ListRow> = {}): ListRow {
  return {
    id: 'l1',
    userId: 'u1',
    kind: 'custom',
    name: 'Scrambles',
    slug: 'scrambles',
    description: null,
    isPublic: false,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    user: OWNER,
    ...over,
  };
}

const AGGREGATE: ListAggregate = {
  count: 3,
  lengthM: 24_100,
  gainM: 1_640,
  coverPhotoUrl: 'https://cdn.test/a.jpg',
  lengths: [8_200, 11_400, 4_500],
};

describe('toSummaryShape', () => {
  it('carries the aggregate onto the card', () => {
    const summary = toSummaryShape(list(), AGGREGATE);
    expect(summary.trailCount).toBe(3);
    expect(summary.totalLengthM).toBe(24_100);
    expect(summary.totalGainM).toBe(1_640);
    expect(summary.coverPhotoUrl).toBe('https://cdn.test/a.jpg');
  });

  it('carries the per-trail lengths through in order, for the tally rule', () => {
    expect(toSummaryShape(list(), AGGREGATE).lengths).toEqual([8_200, 11_400, 4_500]);
  });

  it('exposes only the owner fields a public list should show', () => {
    const summary = toSummaryShape(list(), AGGREGATE);
    expect(Object.keys(summary.owner).sort()).toEqual(['id', 'image', 'name', 'username']);
  });
});

describe('inDisplayOrder', () => {
  it('puts the three system lists in their fixed order, ahead of custom ones', () => {
    const rows = [
      list({ id: 'c', kind: 'custom', name: 'Scrambles' }),
      list({ id: 'done', kind: 'completed', name: 'Completed' }),
      list({ id: 'want', kind: 'want_to_do', name: 'Want to do' }),
      list({ id: 'fav', kind: 'favorites', name: 'Favorites' }),
    ];
    expect(inDisplayOrder(rows).map((row) => row.id)).toEqual(['fav', 'want', 'done', 'c']);
  });

  it('sorts custom lists most-recently-touched first', () => {
    const rows = [
      list({ id: 'old', updatedAt: new Date('2025-01-01T00:00:00Z') }),
      list({ id: 'new', updatedAt: new Date('2025-06-01T00:00:00Z') }),
      list({ id: 'mid', updatedAt: new Date('2025-03-01T00:00:00Z') }),
    ];
    expect(inDisplayOrder(rows).map((row) => row.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not mutate what it was given', () => {
    const rows = [list({ id: 'c', kind: 'custom' }), list({ id: 'fav', kind: 'favorites' })];
    inDisplayOrder(rows);
    expect(rows.map((row) => row.id)).toEqual(['c', 'fav']);
  });
});

describe('toDateString', () => {
  it('slices at UTC so a stored midnight reads back as the day it was written', () => {
    expect(toDateString(new Date('2025-04-06T00:00:00Z'))).toBe('2025-04-06');
  });

  it('keeps a late-evening UTC instant on its own day', () => {
    expect(toDateString(new Date('2025-04-06T23:59:59Z'))).toBe('2025-04-06');
  });
});
