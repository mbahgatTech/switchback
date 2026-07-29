import { describe, expect, it } from 'vitest';
import { EMPTY_FACETS, type Facets } from '../src/components/explore/facets';
import {
  exploreUrlSearch,
  parseExploreUrl,
  type ExploreUrlState,
} from '../src/components/explore/url-state';

/**
 * The URL codec.
 *
 * The tests that matter here are the round trip and the hostile input, because those are
 * the two ways this fails in the field: a link that does not restore what it captured, and
 * a link somebody edited by hand. Everything in between is spelling.
 */

const BASE: ExploreUrlState = {
  view: null,
  query: '',
  trailId: null,
  facets: EMPTY_FACETS,
};

function roundTrip(state: ExploreUrlState): ExploreUrlState {
  return parseExploreUrl(exploreUrlSearch(state));
}

describe('exploreUrlSearch', () => {
  it('writes nothing when nothing has been chosen', () => {
    expect(exploreUrlSearch(BASE)).toBe('');
  });

  it('spells the viewport the way OSM does', () => {
    const search = exploreUrlSearch({
      ...BASE,
      view: { center: [-4.0765, 53.0685], zoom: 12.5 },
    });
    expect(new URLSearchParams(search).get('map')).toBe('12.5/53.0685/-4.0765');
  });

  it('trims trailing zeros rather than padding to the precision cap', () => {
    const search = exploreUrlSearch({ ...BASE, view: { center: [-4, 53], zoom: 11 } });
    expect(new URLSearchParams(search).get('map')).toBe('11/53/-4');
  });

  it('omits the default sort but keeps a chosen one', () => {
    expect(exploreUrlSearch(BASE)).not.toContain('sort');
    expect(exploreUrlSearch({ ...BASE, facets: { ...EMPTY_FACETS, sort: 'rating' } })).toContain(
      'sort=rating',
    );
  });

  it('writes an open-ended band with the missing end left blank', () => {
    const facets: Facets = { ...EMPTY_FACETS, minLengthM: 25_000 };
    expect(new URLSearchParams(exploreUrlSearch({ ...BASE, facets })).get('len')).toBe('25000-');
  });
});

describe('parseExploreUrl', () => {
  it('reads an empty query string as the default state', () => {
    expect(parseExploreUrl('')).toEqual(BASE);
  });

  it('survives a full round trip', () => {
    const state: ExploreUrlState = {
      view: { center: [-121.4271, 48.0135], zoom: 13.25 },
      query: 'vesper peak',
      trailId: 'clx0000000000000000000000',
      facets: {
        difficulty: ['hard'],
        routeType: ['out_and_back'],
        activityTypes: ['hiking', 'scrambling'],
        minLengthM: 5_000,
        maxLengthM: 12_000,
        minGainM: 800,
        maxGainM: 1_500,
        dogsAllowed: true,
        wheelchairAccessible: false,
        sort: 'length_desc',
      },
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it('keeps a query with a space in it', () => {
    expect(roundTrip({ ...BASE, query: 'mount si' }).query).toBe('mount si');
  });

  /*
   * A URL is user input. The values below are the shapes that actually arrive — an old
   * link from before a rename, a truncated paste, someone typing in the address bar — and
   * every one of them must degrade to the default rather than reach the API, where it
   * becomes a validation error for something the user cannot see or fix.
   */
  it.each([
    ['map=', 'a blank viewport'],
    ['map=12', 'a zoom with no position'],
    ['map=12/53', 'a truncated pair'],
    ['map=12/53/-4/9', 'an extra component'],
    ['map=abc/def/ghi', 'words'],
    ['map=12/91/-4', 'a latitude off the globe'],
    ['map=12/53/-200', 'a longitude off the globe'],
    ['map=99/53/-4', 'a zoom past any tile pyramid'],
  ])('drops %s (%s)', (search) => {
    expect(parseExploreUrl(search).view).toBeNull();
  });

  it('drops unknown facet values and keeps the known ones beside them', () => {
    const facets = parseExploreUrl('diff=hard,extreme,easy&route=spiral&act=hiking').facets;
    expect(facets.difficulty).toEqual(['hard', 'easy']);
    expect(facets.routeType).toEqual([]);
    expect(facets.activityTypes).toEqual(['hiking']);
  });

  it('deduplicates a repeated value', () => {
    expect(parseExploreUrl('diff=easy,easy,easy').facets.difficulty).toEqual(['easy']);
  });

  it('falls back to the default sort when asked for one that does not exist', () => {
    expect(parseExploreUrl('sort=cheapest').facets.sort).toBe('popularity');
  });

  it('reads a one-ended band without inventing the other end', () => {
    const facets = parseExploreUrl('len=-5000&gain=1500-').facets;
    expect(facets.minLengthM).toBeUndefined();
    expect(facets.maxLengthM).toBe(5_000);
    expect(facets.minGainM).toBe(1_500);
    expect(facets.maxGainM).toBeUndefined();
  });

  it('treats an access flag as tri-state, not boolean', () => {
    expect(parseExploreUrl('').facets.dogsAllowed).toBeUndefined();
    expect(parseExploreUrl('dogs=1').facets.dogsAllowed).toBe(true);
    expect(parseExploreUrl('dogs=0').facets.dogsAllowed).toBe(false);
    // Anything else is not a third meaning — it is noise, and noise means "not filtering".
    expect(parseExploreUrl('dogs=yes').facets.dogsAllowed).toBeUndefined();
  });

  it('accepts a leading question mark, which is how callers hold it', () => {
    expect(parseExploreUrl('?q=snowdon').query).toBe('snowdon');
  });
});
