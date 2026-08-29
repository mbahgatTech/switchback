/**
 * The measured drain rate, and the conversion every throughput-sized ceiling goes through. What
 * these pin is that a horizon in hours and the job count derived from it cannot disagree.
 */

import { describe, expect, it } from 'vitest';
import { ESTATE_DRAIN_TILES_PER_HOUR, hoursToDrain, queueDepthForHours } from '../src/drain-rate';

describe('a wait horizon expressed as a queue depth', () => {
  it('never admits more jobs than the estate drains in the time promised', () => {
    // The claim a horizon makes. Rounding has to fall this way: a depth that drains in longer than
    // the horizon is the defect — a ceiling quietly promising less wait than it delivers.
    for (const hours of [1, 6, 12, 18, 24, 48]) {
      expect(hoursToDrain(queueDepthForHours(hours))).toBeLessThanOrEqual(hours);
    }
  });

  it('gives up less than one tile of the horizon to rounding', () => {
    // The other side of it: floor must not throw away real capacity, or a horizon somebody raises
    // by an hour buys fewer jobs than the hour is worth.
    const oneTile = 1 / ESTATE_DRAIN_TILES_PER_HOUR;
    for (const hours of [1, 6, 12, 18, 24, 48]) {
      expect(hoursToDrain(queueDepthForHours(hours))).toBeGreaterThan(hours - oneTile);
    }
  });

  it('admits nothing for no time at all', () => {
    expect(queueDepthForHours(0)).toBe(0);
    expect(hoursToDrain(0)).toBe(0);
  });
});
