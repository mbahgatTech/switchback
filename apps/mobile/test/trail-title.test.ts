import { describe, expect, it } from 'vitest';
import { displayNameOf, trailTitle } from '@switchback/core';
import type { OfflineTrailSummary } from '../src/offline/store';

/**
 * The offline half of titling. The fallback itself is core's and tested there; what only this
 * app can check is that an index written before the column existed still shows a name.
 */

describe('an offline index written before displayName existed', () => {
  // Byte for byte what a manifest from the previous build parses to: no such key at all.
  const parsed: unknown = JSON.parse(
    '{"trailId":"c1","slug":"headlee-pass-trail","name":"Headlee Pass Trail",' +
      '"regionName":"Snohomish County","lengthM":9012,"gainM":1082,"photos":4,' +
      '"savedAt":1735689600000,"bytes":8123456}',
  );
  const saved = parsed as OfflineTrailSummary;

  it('still titles from the OSM name rather than blank', () => {
    expect(saved.displayName).toBeUndefined();
    expect(trailTitle(saved)).toBe('Headlee Pass Trail');
  });

  it('records nothing rather than a blank when a fresh download stores one', () => {
    // What `downloadTrail` writes into the index for each of the three shapes the API can send.
    expect(displayNameOf({ name: 'Headlee Pass Trail', displayName: null })).toBeNull();
    expect(displayNameOf({ name: 'Headlee Pass Trail', displayName: '' })).toBeNull();
    expect(displayNameOf({ name: 'Headlee Pass Trail', displayName: 'Vesper Peak via it' })).toBe(
      'Vesper Peak via it',
    );
  });
});
