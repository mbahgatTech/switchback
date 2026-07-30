import { describe, expect, it } from 'vitest';
import { formatPlaceCookie, parsePlaceCookie, placeCamera, placeLabel } from '../src/lib/place';

/**
 * The front page is a function of this cookie, and the cookie is text a browser hands us.
 * Everything here is a case where a wrong answer is *plausible* rather than obviously
 * broken — a coordinate in the sea, a city on the wrong side of a comma — because those are
 * the ones that ship.
 */

describe('parsePlaceCookie', () => {
  it('round-trips a place through the cookie', () => {
    const place = { at: [-3.0645, 54.4542] as [number, number], source: 'search' as const };
    expect(parsePlaceCookie(formatPlaceCookie(place))).toEqual(place);
  });

  it('keeps a name that contains the separator', () => {
    // "Cardiff, Wales" is one field with a comma in it, and the name is last precisely so
    // that it can be.
    const cookie = formatPlaceCookie({
      at: [-3.18, 51.48],
      source: 'network',
      name: 'Cardiff, Wales',
    });
    expect(parsePlaceCookie(cookie)?.name).toBe('Cardiff, Wales');
  });

  it('refuses an empty coordinate field rather than reading it as zero', () => {
    // `Number('')` is 0, and 0 is a valid longitude and a valid latitude — so the naive
    // version of this parser answers "Null Island" to a cookie that says nothing at all.
    expect(parsePlaceCookie(',,browser')).toBeNull();
    expect(parsePlaceCookie(', ,search')).toBeNull();
    expect(parsePlaceCookie('-3.06,,search')).toBeNull();
  });

  it('still accepts a genuine zero', () => {
    // The guard above must reject absence, not the number. Somebody standing on the prime
    // meridian in Greenwich has a longitude of 0 and is entitled to a list of trails.
    expect(parsePlaceCookie('0,51.48,browser')?.at).toEqual([0, 51.48]);
  });

  it('rejects coordinates outside the world', () => {
    expect(parsePlaceCookie('-181,0,search')).toBeNull();
    expect(parsePlaceCookie('0,91,search')).toBeNull();
    expect(parsePlaceCookie('north,west,search')).toBeNull();
    expect(parsePlaceCookie('Infinity,0,search')).toBeNull();
  });

  it('rejects a source it did not write', () => {
    expect(parsePlaceCookie('-3.06,54.45,guess')).toBeNull();
    expect(parsePlaceCookie('-3.06,54.45')).toBeNull();
  });

  it('treats a missing cookie as no place at all', () => {
    expect(parsePlaceCookie(undefined)).toBeNull();
    expect(parsePlaceCookie('')).toBeNull();
  });

  it('caps a name that arrived far too long', () => {
    const cookie = `-3.06,54.45,network,${'x'.repeat(500)}`;
    expect(parsePlaceCookie(cookie)?.name).toHaveLength(80);
  });
});

describe('placeLabel', () => {
  it('claims "your location" only for a browser fix', () => {
    expect(placeLabel({ at: [0, 51], source: 'browser' })).toBe('your location');
    expect(placeLabel({ at: [0, 51], source: 'browser', name: 'Greenwich' })).toBe('your location');
  });

  it('names the place for anything inferred, so a reader can see it is wrong', () => {
    expect(placeLabel({ at: [0, 51], source: 'network', name: 'Cardiff' })).toBe('Cardiff');
    expect(placeLabel({ at: [0, 51], source: 'search', name: 'Vesper Peak' })).toBe('Vesper Peak');
  });

  it('falls back to a word that promises nothing when there is no name', () => {
    expect(placeLabel({ at: [0, 51], source: 'network' })).toBe('here');
  });
});

/**
 * The zoom table, written down where it cannot be tidied away.
 *
 * Three numbers with three different reasons, none of which is visible from the constants
 * themselves — which is exactly the shape of thing somebody unifies into one `DEFAULT_ZOOM`
 * on a quiet afternoon. The literals are asserted rather than the exported constants, so a
 * change to a constant fails here instead of passing tautologically against itself.
 */
describe('placeCamera', () => {
  it('opens on Seattle when the reader has told us nothing', () => {
    expect(placeCamera(null)).toEqual({ center: [-122.33, 47.61], zoom: 10 });
  });

  it('trusts a browser fix', () => {
    const at: [number, number] = [-121.51188, 48.01213];
    expect(placeCamera({ at, source: 'browser' })).toEqual({ center: at, zoom: 11 });
  });

  it('trusts a searched place', () => {
    const at: [number, number] = [-121.51188, 48.01213];
    expect(placeCamera({ at, source: 'search', name: 'Vesper Peak' })).toEqual({
      center: at,
      zoom: 11,
    });
  });

  it('opens wider on a guess than on a fix', () => {
    // An IP lookup is city-accurate at best and the wrong side of a country on a VPN. One
    // step out is where the map says so, since it has no room to say it in words.
    const at: [number, number] = [-3.18, 51.48];
    expect(placeCamera({ at, source: 'network', name: 'Cardiff' })).toEqual({
      center: at,
      zoom: 10,
    });
  });

  it('is no more confident about nothing than about a guess', () => {
    // Knowing neither a cookie nor an edge header is strictly less than knowing an IP city,
    // so the fallback must never open tighter than the network case.
    expect(placeCamera(null).zoom).toBeLessThanOrEqual(
      placeCamera({ at: [-3.18, 51.48], source: 'network' }).zoom,
    );
  });
});
