import { afterEach, describe, expect, it } from 'vitest';
import {
  OVERPASS_MAX_CONCURRENT,
  OVERPASS_MAX_TOTAL_MS,
  getOverpass,
  resetIngestSingletons,
} from '../src/config';

/** The singleton reads `process.env` once, so every case here starts from a clean client. */
afterEach(() => {
  resetIngestSingletons();
  delete process.env.OVERPASS_MAX_CONCURRENT;
  delete process.env.OVERPASS_MAX_TOTAL_MS;
});

process.env.OVERPASS_USER_AGENT ??= 'Switchback/test (+https://switchback-three.vercel.app)';

/** Both numbers live behind private fields; this is the only honest way to read them back. */
function limits(): { maxConcurrent: number; maxTotalMs: number } {
  return getOverpass() as unknown as { maxConcurrent: number; maxTotalMs: number };
}

describe('getOverpass', () => {
  it('allots itself two slots, which is not a tuning knob', () => {
    /*
     * Overpass grants slots per client IP and two is the documented-safe figure; a client that
     * helps itself to more is blocked, and the block outlasts the run that earned it. Raising
     * this is a decision about somebody else's donated hardware, so it fails a test rather than
     * passing review as a performance tweak.
     */
    expect(OVERPASS_MAX_CONCURRENT).toBe(2);
    expect(limits().maxConcurrent).toBe(2);
  });

  it('takes the two limits from the environment when they are numbers', () => {
    process.env.OVERPASS_MAX_CONCURRENT = '1';
    process.env.OVERPASS_MAX_TOTAL_MS = '90000';

    expect(limits().maxConcurrent).toBe(1);
    expect(limits().maxTotalMs).toBe(90_000);
  });

  it.each(['two', '', '  ', '0', '-1'])(
    'falls back to the defaults rather than NaN on %o',
    (value) => {
      process.env.OVERPASS_MAX_CONCURRENT = value;
      process.env.OVERPASS_MAX_TOTAL_MS = value;

      /*
       * `Math.max(1, NaN)` is `NaN` and `active < NaN` is always false, so a mistyped
       * concurrency used to park every caller in the semaphore's wait list with nothing left to
       * release them: no timeout, no error, no log — a wasted ten-minute invocation per message.
       */
      expect(limits().maxConcurrent).toBe(OVERPASS_MAX_CONCURRENT);
      expect(limits().maxTotalMs).toBe(OVERPASS_MAX_TOTAL_MS);
    },
  );
});
