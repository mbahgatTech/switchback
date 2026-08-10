import { describe, expect, it } from 'vitest';
import { ATTRIBUTION, ATTRIBUTION_SOURCES, licenceUri, requiresAttribution } from '../src';

describe('licenceUri', () => {
  /*
   * The identifiers Commons actually returns, counted over the seeded corpus: CC BY-SA 4.0,
   * CC BY-SA 3.0, CC BY 3.0, CC BY-SA 2.0, CC BY 2.0 and public domain. Every one has to
   * resolve, because a credit line that names a licence without linking its deed does not
   * satisfy CC BY-SA 4.0 §3.a.1(C).
   */
  it('resolves every licence the seeded photographs carry', () => {
    expect(licenceUri('CC BY-SA 4.0')).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    expect(licenceUri('CC BY-SA 3.0')).toBe('https://creativecommons.org/licenses/by-sa/3.0/');
    expect(licenceUri('CC BY 3.0')).toBe('https://creativecommons.org/licenses/by/3.0/');
    expect(licenceUri('CC BY-SA 2.0')).toBe('https://creativecommons.org/licenses/by-sa/2.0/');
    expect(licenceUri('CC BY 2.0')).toBe('https://creativecommons.org/licenses/by/2.0/');
    expect(licenceUri('CC0')).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(licenceUri('Public domain')).toBe('https://en.wikipedia.org/wiki/Public_domain');
  });

  it('returns null rather than guessing at something it does not recognise', () => {
    // A wrong deed link is a false licence statement, which is worse than no link.
    expect(licenceUri('Esri terms of use')).toBeNull();
    expect(licenceUri('')).toBeNull();
    expect(licenceUri(null)).toBeNull();
    expect(licenceUri(undefined)).toBeNull();
  });

  it('reads the non-commercial and no-derivatives variants rather than dropping them', () => {
    expect(licenceUri('CC BY-NC 4.0')).toBe('https://creativecommons.org/licenses/by-nc/4.0/');
    expect(licenceUri('CC BY-NC-SA 3.0')).toBe(
      'https://creativecommons.org/licenses/by-nc-sa/3.0/',
    );
  });
});

describe('requiresAttribution', () => {
  it('is true for every BY variant and false for the ones that waive it', () => {
    expect(requiresAttribution('CC BY-SA 4.0')).toBe(true);
    expect(requiresAttribution('CC BY 2.0')).toBe(true);
    expect(requiresAttribution('CC0')).toBe(false);
    expect(requiresAttribution('Public domain')).toBe(false);
    expect(requiresAttribution(null)).toBe(false);
  });
});

describe('the credits page', () => {
  /*
   * 83 of the 85 photographs seeded during this work carried a licence requiring attribution,
   * while the page named no photograph source at all. A reader has to be able to find out where
   * the pictures came from without reading the source.
   */
  it('names where trail photographs come from', () => {
    const keys = ATTRIBUTION_SOURCES.map((source) => source.key);
    expect(keys).toContain('wikimediaCommons');
    expect(keys).toContain('mapillary');
  });

  it('gives every listed source a link and a licence', () => {
    for (const source of ATTRIBUTION_SOURCES) {
      const entry = ATTRIBUTION[source.key];
      expect(entry.href).toMatch(/^https:\/\//);
      expect(entry.licence.length).toBeGreaterThan(0);
    }
  });
});
