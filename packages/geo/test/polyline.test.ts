import { describe, expect, it } from 'vitest';
import type { LngLat } from '@switchback/core';
import { isClosedLoop, lineLengthM, resampleLine, simplifyLine } from '@switchback/geo';
import { lineNorth, offset, square } from './helpers';

describe('resampleLine', () => {
  it('produces evenly spaced points at the requested spacing', () => {
    const out = resampleLine(lineNorth([0, 45], 1000, 3), 25);
    expect(out).toHaveLength(41); // 40 intervals of 25 m
    for (let i = 1; i < out.length; i++) {
      expect(lineLengthM([out[i - 1]!, out[i]!])).toBeCloseTo(25, 1);
    }
  });

  it('preserves the first and last vertices exactly', () => {
    const line = lineNorth([7.2, 46.1], 900, 4);
    const out = resampleLine(line, 30);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it('preserves total length', () => {
    const line = lineNorth([0, 45], 1000, 3);
    expect(lineLengthM(resampleLine(line, 25))).toBeCloseTo(lineLengthM(line), 1);
  });

  it('normalises the wildly uneven vertex spacing OSM actually ships', () => {
    // One 900 m straight followed by three 10 m switchback vertices.
    const start: LngLat = [0, 45];
    const uneven: LngLat[] = [
      start,
      offset(start, 900, 0),
      offset(start, 910, 0),
      offset(start, 920, 0),
      offset(start, 930, 0),
    ];
    const out = resampleLine(uneven, 25);
    const gaps: number[] = [];
    for (let i = 1; i < out.length; i++) gaps.push(lineLengthM([out[i - 1]!, out[i]!]));
    const max = Math.max(...gaps);
    const min = Math.min(...gaps);
    expect(max - min).toBeLessThan(1);
  });

  it('handles degenerate input without hanging or throwing', () => {
    expect(resampleLine([[0, 0]], 25)).toEqual([[0, 0]]);
    expect(resampleLine([], 25)).toEqual([]);
    expect(
      resampleLine(
        [
          [0, 0],
          [0, 0],
        ],
        25,
      ),
    ).toEqual([[0, 0]]);
  });

  it('rejects a non-positive spacing rather than looping forever', () => {
    expect(() => resampleLine(lineNorth([0, 45], 100, 3), 0)).toThrow(/positive/);
  });
});

describe('simplifyLine', () => {
  it('reduces a straight line to its two endpoints', () => {
    const line = lineNorth([0, 45], 5000, 200);
    const out = simplifyLine(line, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(line[0]);
    expect(out[1]).toEqual(line[line.length - 1]);
  });

  it('keeps a deviation larger than the tolerance', () => {
    const start: LngLat = [0, 45];
    const line: LngLat[] = [start, offset(start, 500, 40), offset(start, 1000, 0)];
    expect(simplifyLine(line, 10)).toHaveLength(3);
    expect(simplifyLine(line, 100)).toHaveLength(2);
  });

  it('never drops the endpoints and never grows the line', () => {
    const line = square([0, 45], 400);
    const out = simplifyLine(line, 20);
    expect(out.length).toBeLessThanOrEqual(line.length);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it('preserves the corners of a square circuit', () => {
    // 4 corners + the coincident start/end vertex.
    expect(simplifyLine(square([0, 45], 400), 20)).toHaveLength(5);
  });

  it('is a no-op for a zero tolerance or a two-point line', () => {
    const line = lineNorth([0, 45], 1000, 9);
    expect(simplifyLine(line, 0)).toEqual(line);
    expect(simplifyLine([line[0]!, line[1]!], 50)).toHaveLength(2);
  });

  it('stays fast on the worst input there is — a jittery recorded track', () => {
    // Six hours of 1 Hz jitter either side of the line: nothing prunes, so RDP does its full
    // O(n²) work and must not take tens of seconds.
    const start: LngLat = [0, 45];
    const jittery = Array.from({ length: 20_000 }, (_, i) =>
      offset(start, i * 5, i % 2 === 0 ? 0 : 30),
    );
    const began = performance.now();
    const out = simplifyLine(jittery, 1);
    expect(performance.now() - began).toBeLessThan(5000);
    expect(out.length).toBeLessThanOrEqual(jittery.length);
  });
});

describe('isClosedLoop', () => {
  it('is true when the line returns to its start', () => {
    expect(isClosedLoop(square([0, 45], 500))).toBe(true);
  });

  it('is false for an open line', () => {
    expect(isClosedLoop(lineNorth([0, 45], 3000, 10))).toBe(false);
  });

  it('respects the threshold', () => {
    const line = lineNorth([0, 45], 150, 5);
    expect(isClosedLoop(line, 200)).toBe(true);
    expect(isClosedLoop(line, 100)).toBe(false);
  });

  it('needs at least three points to be a loop at all', () => {
    expect(
      isClosedLoop([
        [0, 45],
        [0, 45],
      ]),
    ).toBe(false);
  });
});
