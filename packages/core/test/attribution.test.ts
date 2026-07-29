import { describe, expect, it } from 'vitest';
import { ATTRIBUTION, ATTRIBUTION_SOURCES, BRAND } from '../src/brand';

/**
 * Attribution is a licence condition, and the failure mode is silence.
 *
 * Nothing about a missing credit is loud. The map still draws, the app still ships, and the
 * only signal is that a source we use is not named anywhere a reader can find it — which is
 * the state ODbL and CC-BY both prohibit. These assertions are the alarm, and they are cheap
 * enough to be worth having for exactly that reason.
 */

describe('attribution', () => {
  it('credits every source it names, and names every source it credits', () => {
    const credited = ATTRIBUTION_SOURCES.map((source) => source.key);

    // Both directions, and the second is the one that matters. A key added to `ATTRIBUTION`
    // for a new layer is a source now in use; if the published list does not mention it,
    // the product is using data it does not credit and nothing else would say so.
    expect([...credited].sort()).toEqual(Object.keys(ATTRIBUTION).sort());
    expect(new Set(credited).size).toBe(credited.length);
  });

  it('gives every credit a licence and a link that resolves to the licensor', () => {
    for (const [key, credit] of Object.entries(ATTRIBUTION)) {
      expect(credit.label.length, key).toBeGreaterThan(0);
      expect(credit.licence.length, key).toBeGreaterThan(0);
      // https, not http: an attribution link that a browser refuses to follow, or that a
      // network can rewrite in flight, is not the notice the licence asked for.
      expect(credit.href, key).toMatch(/^https:\/\//u);
    }
  });

  it('says what each source is for in the reader’s terms, not the schema’s', () => {
    for (const source of ATTRIBUTION_SOURCES) {
      expect(source.what.length, source.key).toBeGreaterThan(0);
      expect(source.detail.length, source.key).toBeGreaterThan(0);
    }
  });

  it('points the User-Agent contact at a page that exists', () => {
    // Overpass and Nominatim are told where to complain via this URL. It has to be the
    // attribution page rather than a bare domain, because that page is the one that says
    // who we are and what we are doing with the data.
    expect(BRAND.contactUrl).toBe(`https://${BRAND.domain}/attribution`);
  });
});
