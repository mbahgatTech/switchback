import { describe, expect, it } from 'vitest';
import type { OfflineTrailSummary } from '../src/offline/store';
import { displayNameOf, trailTitle } from '../src/api/trail-title';

/**
 * The fallback, which is the whole of this helper. No simulator runs on the build machine, so
 * this file is where "a download made before the column exists still shows a name" is checked.
 */

describe('trailTitle', () => {
  it('prints the derived title when there is one', () => {
    const trail = {
      name: 'Headlee Pass Trail',
      displayName: 'Vesper Peak via Headlee Pass Trail',
    };
    expect(trailTitle(trail)).toBe('Vesper Peak via Headlee Pass Trail');
  });

  it('falls back to the OSM name when nothing was derived', () => {
    expect(trailTitle({ name: 'Headlee Pass Trail', displayName: null })).toBe(
      'Headlee Pass Trail',
    );
    expect(trailTitle({ name: 'Headlee Pass Trail' })).toBe('Headlee Pass Trail');
    expect(trailTitle({ name: 'Headlee Pass Trail', displayName: '  ' })).toBe(
      'Headlee Pass Trail',
    );
  });

  it('reads an index line written before the column existed', () => {
    // Byte for byte what a manifest from the previous build parses to: no such key at all.
    const parsed: unknown = JSON.parse(
      '{"trailId":"c1","slug":"headlee-pass-trail","name":"Headlee Pass Trail",' +
        '"regionName":"Snohomish County","lengthM":9012,"gainM":1082,"photos":4,' +
        '"savedAt":1735689600000,"bytes":8123456}',
    );
    const saved = parsed as OfflineTrailSummary;

    expect(saved.displayName).toBeUndefined();
    expect(trailTitle(saved)).toBe('Headlee Pass Trail');
  });
});

describe('displayNameOf', () => {
  it('reports nothing rather than a blank for every absent case', () => {
    expect(displayNameOf({ name: 'Trail' })).toBeNull();
    expect(displayNameOf({ name: 'Trail', displayName: null })).toBeNull();
    expect(displayNameOf({ name: 'Trail', displayName: '' })).toBeNull();
    expect(displayNameOf({ name: 'Trail', displayName: 'Lake via Trail' })).toBe('Lake via Trail');
  });
});
