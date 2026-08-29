import { describe, expect, it } from 'vitest';
import type { TrackFix } from '@switchback/core';
import {
  JOURNAL_VERSION,
  decodeFixes,
  decodeHead,
  encodeFixes,
  encodeHead,
  restoredPhase,
  type JournalHead,
} from '../src/record/journal';

/**
 * The journal is the only thing standing between a six-hour hike and an app the OS decided to
 * reclaim. What is checked here is what survives that: a torn write, a stale format, and the
 * rule for whether a restored hike is still running.
 */

const head: JournalHead = {
  v: JOURNAL_VERSION,
  id: 'act_1',
  startedAt: 1_735_689_600_000,
  trailId: 'trail_1',
  routeId: null,
  sent: 2,
  live: true,
};

const fixes: TrackFix[] = [
  { t: 0, lng: -121.49, lat: 48.02, eleM: 610, accuracyM: 8, speedMps: 0 },
  { t: 1, lng: -121.489, lat: 48.021, eleM: 612, accuracyM: 8, speedMps: 1.2 },
  { t: 2, lng: -121.488, lat: 48.022, eleM: 615, accuracyM: 9, speedMps: 1.3 },
];

describe('a journal written and read back whole', () => {
  it('round-trips the head', () => {
    expect(decodeHead(encodeHead(head))).toEqual(head);
  });

  it('round-trips every fix, in order', () => {
    expect(decodeFixes(encodeFixes(fixes))).toEqual(fixes);
  });

  it('reads nothing from an empty file rather than throwing', () => {
    expect(decodeFixes('')).toEqual([]);
  });
});

describe('a journal the phone was killed in the middle of writing', () => {
  /*
   * Byte for byte what a kill mid-append leaves: whole lines, then a fragment with no newline.
   * This is the case the whole append-only format exists for.
   */
  const torn = `${encodeFixes(fixes)}{"t":3,"lng":-121.487,"lat":4`;

  it('keeps every fix that finished being written', () => {
    expect(decodeFixes(torn)).toEqual(fixes);
  });

  it('drops the half-written one instead of failing the whole hike', () => {
    expect(decodeFixes(torn)).toHaveLength(fixes.length);
  });

  it('drops a line that parses but is not a fix', () => {
    const wrong = `${encodeFixes(fixes)}{"t":"three","lng":null,"lat":null}\n`;
    expect(decodeFixes(wrong)).toEqual(fixes);
  });
});

describe('a head that cannot be trusted', () => {
  it('refuses a version this build does not write', () => {
    expect(decodeHead(JSON.stringify({ ...head, v: JOURNAL_VERSION - 1 }))).toBeNull();
  });

  it('refuses a head with no activity id, which would name a recording the server never opened', () => {
    expect(decodeHead(JSON.stringify({ ...head, id: 42 }))).toBeNull();
  });

  it('refuses a file that is not JSON at all', () => {
    expect(decodeHead('{"v":2,"id":')).toBeNull();
  });

  it('reads a missing live flag as not live, so a hike never restarts itself by omission', () => {
    const older: Record<string, unknown> = { ...head };
    delete older.live;
    expect(decodeHead(JSON.stringify(older))?.live).toBe(false);
  });
});

describe('what phase a restored recording takes', () => {
  it('carries on recording when the OS still holds the location task', () => {
    expect(restoredPhase(head, true)).toBe('recording');
  });

  it('comes back paused when the task is gone, because the track has a hole in it', () => {
    expect(restoredPhase(head, false)).toBe('paused');
  });

  it('comes back paused when the hike was already paused, task or no task', () => {
    expect(restoredPhase({ ...head, live: false }, true)).toBe('paused');
  });
});
