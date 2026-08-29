import { describe, expect, it } from 'vitest';
import { NO_DATA_ELEVATION, lineLengthM, resampleLine } from '@switchback/geo';
import { TerrainSource, decodeTerrarium, elevateLine, fillGaps } from '../src/elevate';
import { IngestDeadlineError } from '../src/deadline';
import { TERRARIUM_TILE_SIZE } from '@switchback/geo';
import { flatTile, pngResponse } from './fixtures/terrarium';

describe('decodeTerrarium', () => {
  it('round-trips a known elevation through the RGB encoding', () => {
    const tile = decodeTerrarium(flatTile(1000), 13, 4000, 2600);
    expect(tile.width).toBe(TERRARIUM_TILE_SIZE);
    expect(tile.channels).toBe(4);
    // First pixel, decoded by hand the way `@switchback/geo` does it.
    const elev = tile.data[0]! * 256 + tile.data[1]! + tile.data[2]! / 256 - 32768;
    expect(elev).toBeCloseTo(1000, 6);
  });

  it('refuses a well-formed PNG that is not a tile, rather than stamping one out of it', () => {
    // The coordinates are stamped from the arguments and never read from the body, so without
    // this a 1x1 PNG becomes a tile whose every sample clamps to pixel (0,0).
    expect(() => decodeTerrarium(flatTile(1000, 1), 13, 4000, 2600)).toThrow(/not a 256px/u);
    expect(() => decodeTerrarium(flatTile(1000, 128), 13, 4000, 2600)).toThrow(/128x128/u);
  });

  it('handles a fractional elevation, which is what the blue channel is for', () => {
    const tile = decodeTerrarium(flatTile(1325.5), 13, 0, 0);
    const elev = tile.data[0]! * 256 + tile.data[1]! + tile.data[2]! / 256 - 32768;
    expect(elev).toBeCloseTo(1325.5, 2);
  });
});

describe('TerrainSource', () => {
  it('makes one request for a tile many callers want at once', async () => {
    // Forty trails in a z9 tile share terrain almost completely. Without in-flight
    // deduplication this is forty identical GETs.
    let requests = 0;
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => {
        requests += 1;
        return pngResponse(flatTile(500));
      }) as unknown as typeof fetch,
    });

    const tiles = await Promise.all(Array.from({ length: 40 }, () => source.tile(13, 4000, 2600)));

    expect(requests).toBe(1);
    expect(tiles.every((t) => t !== null)).toBe(true);
  });

  it('serves the second read from cache', async () => {
    let requests = 0;
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => {
        requests += 1;
        return pngResponse(flatTile(500));
      }) as unknown as typeof fetch,
    });

    await source.tile(13, 1, 1);
    await source.tile(13, 1, 1);
    expect(requests).toBe(1);
    expect(source.cachedCount).toBe(1);
  });

  it('treats a 404 as data, not an error — the DEM does not cover open ocean', async () => {
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    });

    await expect(source.tile(13, 1, 1)).resolves.toBeNull();
    // Cached, so a trail crossing the coast does not re-request the missing tile per point.
    expect(source.cachedCount).toBe(1);
  });

  it('retries a 500 and gives up after maxAttempts', async () => {
    let requests = 0;
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      maxAttempts: 3,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        requests += 1;
        return new Response('', { status: 500 });
      }) as unknown as typeof fetch,
    });

    await expect(source.tile(13, 1, 1)).rejects.toThrow(/500/);
    expect(requests).toBe(3);
  });

  it('evicts the least recently used tile once the cache is full', async () => {
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      cacheSize: 2,
      fetchImpl: (async () => pngResponse(flatTile(500))) as unknown as typeof fetch,
    });

    await source.tile(13, 1, 1);
    await source.tile(13, 2, 2);
    await source.tile(13, 3, 3);
    expect(source.cachedCount).toBe(2);
  });

  it('caps concurrent tile fetches', async () => {
    let inFlight = 0;
    let peak = 0;
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      maxConcurrent: 3,
      fetchImpl: (async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return pngResponse(flatTile(500));
      }) as unknown as typeof fetch,
    });

    await Promise.all(Array.from({ length: 20 }, (_, i) => source.tile(13, i, i)));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('gives every request a timeout, so a stalled socket cannot outlive the invocation', async () => {
    let signal: AbortSignal | undefined;
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      requestTimeoutMs: 50,
      fetchImpl: ((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return Promise.resolve(pngResponse(flatTile(500)));
      }) as unknown as typeof fetch,
    });

    await source.tile(13, 1, 1);
    // Node's `fetch` imposes none of its own: without this the handler had no upper bound at
    // all on a tile fetch, which is how an invocation reached 615,938 ms.
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses to start a fetch past the deadline, and does not retry it', async () => {
    let requests = 0;
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => {
        requests += 1;
        return pngResponse(flatTile(500));
      }) as unknown as typeof fetch,
    });

    await expect(source.tile(13, 1, 1, Date.now() - 1)).rejects.toBeInstanceOf(IngestDeadlineError);
    // Not once, and not three times on the retry ladder — a deadline is not a transient fault.
    expect(requests).toBe(0);
  });

  it('still answers from cache once the deadline has passed', async () => {
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => pngResponse(flatTile(500))) as unknown as typeof fetch,
    });

    await source.tile(13, 1, 1);
    // Free, and refusing it would fail a trail over terrain already in hand.
    await expect(source.tile(13, 1, 1, Date.now() - 1)).resolves.not.toBeNull();
  });

  it('releases its concurrency slot when the deadline strikes mid-queue', async () => {
    // The slot is taken before the second check and has to come back, or one expired caller
    // would shrink the semaphore for every caller after it.
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      maxConcurrent: 1,
      fetchImpl: (async () => pngResponse(flatTile(500))) as unknown as typeof fetch,
    });

    await expect(source.tile(13, 9, 9, Date.now() - 1)).rejects.toBeInstanceOf(IngestDeadlineError);
    await expect(source.tile(13, 1, 1)).resolves.not.toBeNull();
  });
});

describe('fillGaps', () => {
  it('leaves a complete profile alone', () => {
    expect(fillGaps([100, 110, 120])).toEqual({ filled: [100, 110, 120], gapCount: 0 });
  });

  it('interpolates linearly between known neighbours', () => {
    const { filled, gapCount } = fillGaps([100, null, null, 400]);
    expect(filled).toEqual([100, 200, 300, 400]);
    expect(gapCount).toBe(2);
  });

  it('clamps at the ends rather than extrapolating a trend off real data', () => {
    const { filled } = fillGaps([null, null, 300, 400, null]);
    expect(filled).toEqual([300, 300, 300, 400, 400]);
  });

  it('treats the terrarium no-data sentinel as a gap, not as -32768 m', () => {
    // Storing the sentinel would put a trail 32 km below sea level and produce a gain
    // figure with six spurious digits.
    const { filled, gapCount } = fillGaps([100, NO_DATA_ELEVATION, 300]);
    expect(filled).toEqual([100, 200, 300]);
    expect(gapCount).toBe(1);
  });

  it('reports an entirely missing profile so the caller can decline to store it', () => {
    const { filled, gapCount } = fillGaps([null, null, null]);
    expect(gapCount).toBe(3);
    expect(filled).toEqual([0, 0, 0]);
  });

  it('handles an empty profile', () => {
    expect(fillGaps([])).toEqual({ filled: [], gapCount: 0 });
  });
});

describe('elevateLine', () => {
  it('produces one point per coordinate with cumulative distance', async () => {
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => pngResponse(flatTile(1000))) as unknown as typeof fetch,
    });

    const coords: Array<[number, number]> = [
      [-4.0, 56.8],
      [-4.0, 56.801],
      [-4.0, 56.802],
    ];
    const profile = await elevateLine(coords, source, { spacingM: 25 });

    expect(profile.points).toHaveLength(3);
    expect(profile.gapCount).toBe(0);
    expect(profile.spacingM).toBe(25);
    expect(profile.points[0]!.distM).toBe(0);
    expect(profile.points[2]!.distM).toBeGreaterThan(200);
    for (const point of profile.points) {
      expect(point.eleM).toBeCloseTo(1000, 0);
    }
    expect(profile.points[1]!.lng).toBe(-4.0);
    expect(profile.points[1]!.lat).toBe(56.801);
  });

  it('marks every sample as a gap when the terrain tiles are missing', async () => {
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    });

    const profile = await elevateLine(
      [
        [-4.0, 56.8],
        [-4.0, 56.801],
      ],
      source,
    );

    // gapCount === points.length is the signal the pipeline uses to skip the trail rather
    // than publish a flat sea-level line with zero gain.
    expect(profile.gapCount).toBe(profile.points.length);
  });

  /**
   * The Pacific Crest Trail regression.
   *
   * A long trail's profile is capped at 6,000 points, so the PCT is resampled at 725 m and
   * the chords between samples cut every switchback in between — 4,221 km measured that way
   * comes out at 3,214 km. The stand-in here is a zigzag whose along-line length is 24 times
   * its chord length, which reproduces the failure in three lines instead of 4,000 km.
   */
  it('measures along the line, not chord to chord, when the true length is given', async () => {
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => pngResponse(flatTile(1000))) as unknown as typeof fetch,
    });

    // A sawtooth: it advances north in small steps while swinging east and west, so hiking
    // it is far longer than the straight line from one end to the other.
    const zigzag: Array<[number, number]> = [];
    for (let i = 0; i <= 40; i++) {
      zigzag.push([-4.0 + (i % 2 === 0 ? 0 : 0.01), 56.8 + i * 0.0002]);
    }

    const trueLengthM = lineLengthM(zigzag);
    // Deliberately coarser than the teeth of the zigzag, the way a 6,000-point cap forces
    // 725 m spacing onto a trail whose switchbacks are 40 m across.
    const resampled = resampleLine(zigzag, 2_000);
    expect(resampled.length).toBeLessThan(zigzag.length); // coarse enough to cut corners

    const chords = await elevateLine(resampled, source, { spacingM: 2_000 });
    const along = await elevateLine(resampled, source, {
      spacingM: 2_000,
      alongLengthM: trueLengthM,
    });

    const last = (p: { points: Array<{ distM: number }> }): number =>
      p.points[p.points.length - 1]!.distM;

    // The bug: chord measurement loses a quarter of the hike.
    expect(last(chords)).toBeLessThan(trueLengthM * 0.9);
    // The fix: exact, not merely closer — resampling spaces its output evenly along the
    // source, so sample i of n sits at length·i/(n−1) by construction.
    expect(last(along)).toBeCloseTo(trueLengthM, 6);
    expect(along.points[0]!.distM).toBe(0);

    const mid = Math.floor((along.points.length - 1) / 2);
    expect(along.points[mid]!.distM).toBeCloseTo(
      (trueLengthM * mid) / (along.points.length - 1),
      6,
    );

    // Distances stay strictly increasing, which every chart, ETA and waypoint assumes.
    for (let i = 1; i < along.points.length; i++) {
      expect(along.points[i]!.distM).toBeGreaterThan(along.points[i - 1]!.distM);
    }

    // The samples themselves are untouched — this changes where a point is said to be along
    // the trail, never where it is on the ground.
    expect(along.points.map((p) => [p.lng, p.lat])).toEqual(
      chords.points.map((p) => [p.lng, p.lat]),
    );
  });

  it('falls back to chord distances when no along-line length is known', async () => {
    const source = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      fetchImpl: (async () => pngResponse(flatTile(1000))) as unknown as typeof fetch,
    });

    const coords: Array<[number, number]> = [
      [-4.0, 56.8],
      [-4.0, 56.801],
      [-4.0, 56.802],
    ];
    // A degenerate length must not be trusted over a real measurement.
    for (const alongLengthM of [undefined, 0, -1, Number.NaN]) {
      const profile = await elevateLine(coords, source, { spacingM: 25, alongLengthM });
      expect(profile.points[2]!.distM).toBeCloseTo(lineLengthM(coords), 6);
    }
  });
});
