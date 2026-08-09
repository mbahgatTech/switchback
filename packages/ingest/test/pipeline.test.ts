import { describe, expect, it } from 'vitest';
import { JobStatus, OsmElementType, Prisma, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  TILE_TTL_MS,
  TRAIL_LOST_MARKER,
  chooseHero,
  fetchWayGeometries,
  isTileFresh,
  pickRegion,
  processTile,
  slugLadder,
} from '../src/pipeline';
import { assignSlugs, planCommitBatches } from '../src/commit-batch';
import type { SlugWant } from '../src/commit-batch';
import type { AssembledTrail } from '../src/assemble';
import type { OverpassClient, OverpassElement } from '../src/overpass';
import { OverpassDeadlineError, OverpassUnavailableError } from '../src/overpass';
import type { TerrainSource } from '../src/elevate';
import { SPLIT_MARKER_PREFIX, SUBTREE_STUCK_MARKER, TILE_SPLIT_MARKER } from '../src/subdivide';
import { MAX_INGEST_ZOOM } from '@switchback/geo';
import type { TerrariumTile } from '@switchback/geo';

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('isTileFresh', () => {
  it('serves cached data inside the TTL', () => {
    expect(isTileFresh({ status: TileStatus.ready, fetchedAt: ago(29 * 24 * 3600_000) }, NOW)).toBe(
      true,
    );
  });

  it('counts an empty tile as fresh, so ocean is not re-queried every request', () => {
    expect(isTileFresh({ status: TileStatus.empty, fetchedAt: ago(1000) }, NOW)).toBe(true);
  });

  it('expires past the TTL', () => {
    expect(isTileFresh({ status: TileStatus.ready, fetchedAt: ago(TILE_TTL_MS + 1) }, NOW)).toBe(
      false,
    );
  });

  it('never serves a tile that failed or is still running', () => {
    // A failed tile with a stale fetchedAt would otherwise render an empty map as though
    // the area genuinely had no trails.
    expect(isTileFresh({ status: TileStatus.failed, fetchedAt: ago(1000) }, NOW)).toBe(false);
    expect(isTileFresh({ status: TileStatus.running, fetchedAt: ago(1000) }, NOW)).toBe(false);
    expect(isTileFresh({ status: TileStatus.pending, fetchedAt: ago(1000) }, NOW)).toBe(false);
  });

  it('treats a never-fetched or absent tile as cold', () => {
    expect(isTileFresh({ status: TileStatus.ready, fetchedAt: null }, NOW)).toBe(false);
    expect(isTileFresh(null, NOW)).toBe(false);
  });
});

describe('pickRegion', () => {
  const area = (level: string, tags: Record<string, string>): OverpassElement => ({
    type: 'area',
    id: Number(level),
    tags: { admin_level: level, ...tags },
  });

  it('prefers the most local administrative name', () => {
    // "Highland" tells a reader more about a trail card than "Scotland" or "United Kingdom".
    const region = pickRegion([
      area('2', { name: 'United Kingdom', 'ISO3166-1:alpha2': 'gb' }),
      area('4', { name: 'Scotland' }),
      area('6', { name: 'Highland' }),
    ]);
    expect(region.regionName).toBe('Highland');
    expect(region.countryCode).toBe('GB');
  });

  it('falls back up the hierarchy when the local level is missing', () => {
    const region = pickRegion([
      area('2', { name: 'France', 'ISO3166-1': 'fr' }),
      area('4', { name: 'Occitanie' }),
    ]);
    expect(region.regionName).toBe('Occitanie');
    expect(region.countryCode).toBe('FR');
  });

  it('never uses the country as a region name', () => {
    const region = pickRegion([area('2', { name: 'Norway', 'ISO3166-1:alpha2': 'NO' })]);
    expect(region.regionName).toBeNull();
    expect(region.countryCode).toBe('NO');
  });

  it('prefers the English name where one is tagged', () => {
    const region = pickRegion([area('6', { name: 'Sør-Trøndelag', 'name:en': 'South Trondelag' })]);
    expect(region.regionName).toBe('South Trondelag');
  });

  it('ignores elements without a usable admin level', () => {
    const region = pickRegion([
      { type: 'area', id: 1, tags: { name: 'Somewhere' } },
      { type: 'area', id: 2 },
      area('x', { name: 'Nonsense' }),
    ]);
    expect(region).toEqual({ regionName: null, countryCode: null });
  });

  it('rejects a country code that is not two letters', () => {
    const region = pickRegion([area('2', { name: 'X', 'ISO3166-1:alpha2': 'GBR' })]);
    expect(region.countryCode).toBeNull();
  });

  it('returns nulls for an empty response, because a region is optional', () => {
    expect(pickRegion([])).toEqual({ regionName: null, countryCode: null });
  });
});

describe('processTile', () => {
  it('refuses a quadkey below the ingest zoom before touching the database', async () => {
    // z8 is a tile twice as wide as ingest is defined for; marking it ready would claim four
    // z9 tiles' worth of ground from one z9 fetch.
    let queried = false;
    const overpass = {
      query: async () => {
        queried = true;
        return { elements: [] };
      },
    } as unknown as OverpassClient;

    await expect(processTile('03331132', { overpass })).rejects.toThrow(/z9-z11 quadkey/);
    expect(queried).toBe(false);
  });

  it('refuses a quadkey past the subdivision floor', async () => {
    // Subdivision stops at z11, so a z12 quadkey is a key nothing in this system produces.
    let queried = false;
    const overpass = {
      query: async () => {
        queried = true;
        return { elements: [] };
      },
    } as unknown as OverpassClient;

    await expect(processTile('033311323012', { overpass })).rejects.toThrow(/z9-z11 quadkey/);
    expect(queried).toBe(false);
  });
});

const DENSE = '120221203';

/** One named way, long enough to survive `MIN_TRAIL_LENGTH_M`. */
const oneTrail: OverpassElement[] = [
  {
    type: 'way',
    id: 42,
    tags: { highway: 'path', name: 'Chamonix Balcon' },
    geometry: [
      { lat: 46.1, lon: 6.5 },
      { lat: 46.11, lon: 6.5 },
    ],
  },
];

interface Recorded {
  updates: Array<{ quadkey: string; data: Record<string, unknown> }>;
  upserts: string[];
  jobs: string[];
}

interface TileRow extends Record<string, unknown> {
  quadkey: string;
  status?: TileStatus;
  fetchedAt?: Date | null;
  lastError?: string | null;
}

/**
 * A Prisma stand-in that *stores* the rows it is given rather than replaying a fixed answer.
 * The difference is load-bearing: `processTile` writes `running` to the parent before it
 * fetches, so a fake whose `findUnique` always returns null cannot tell a parent that was
 * serving trails from one that never has, and the branch that preserves the first is exactly
 * where a bug hid behind a green test.
 */
function fakeDb(
  seed: TileRow[] = [],
  jobs: Record<string, JobStatus> = {},
): {
  db: PrismaClient;
  recorded: Recorded;
} {
  const recorded: Recorded = { updates: [], upserts: [], jobs: [] };
  const tiles = new Map<string, TileRow>(seed.map((row) => [row.quadkey, { ...row }]));
  const db = {
    ingestTile: {
      findUnique: ({ where }: { where: { quadkey: string } }) =>
        Promise.resolve(tiles.get(where.quadkey) ?? null),
      findMany: ({ where }: { where: { quadkey: { in: string[] } } }) =>
        Promise.resolve(
          [...tiles.values()].filter((row) => where.quadkey.in.includes(row.quadkey)),
        ),
      upsert: (args: {
        where: { quadkey: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        recorded.upserts.push(args.where.quadkey);
        const existing = tiles.get(args.where.quadkey);
        tiles.set(
          args.where.quadkey,
          existing
            ? { ...existing, ...args.update, quadkey: args.where.quadkey }
            : { ...args.create, quadkey: args.where.quadkey },
        );
        return Promise.resolve({});
      },
      update: (args: { where: { quadkey: string }; data: Record<string, unknown> }) => {
        recorded.updates.push({ quadkey: args.where.quadkey, data: args.data });
        const existing = tiles.get(args.where.quadkey);
        if (existing) Object.assign(existing, args.data);
        return Promise.resolve({});
      },
    },
    ingestJob: {
      findMany: ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
        Promise.resolve(
          where.dedupeKey.in
            .filter((key) => jobs[key] !== undefined)
            .map((key) => ({ dedupeKey: key, status: jobs[key]! })),
        ),
      updateMany: () => Promise.resolve({ count: 0 }),
      upsert: (args: { where: { dedupeKey: string } }) => {
        recorded.jobs.push(args.where.dedupeKey);
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaClient;
  return { db, recorded };
}

describe('processTile, out of clock', () => {
  it('splits a tile that ran out of clock instead of failing it', async () => {
    // The measured failure: six Alps tiles exhausted the 540 s budget and were written
    // `failed`, retried whole, and failed again. A tile that cannot be finished at this zoom
    // is a tile that has to be finished at the next one.
    const { db, recorded } = fakeDb();
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;

    const result = await processTile(DENSE, {
      db,
      overpass,
      enrichWaypoints: false,
      subdivideMaxZoom: MAX_INGEST_ZOOM,
      deadlineAt: Date.now() - 1,
    });

    expect(result.children).toEqual(['1202212030', '1202212031', '1202212032', '1202212033']);
    expect(recorded.jobs).toEqual(result.children.map((key) => `ingest_tile:${key}`));
    expect(recorded.updates.at(-1)).toEqual({
      quadkey: DENSE,
      data: expect.objectContaining({ status: TileStatus.pending }) as Record<string, unknown>,
    });
    // Nothing anywhere is written `failed`, which is what the retry ladder used to burn on.
    expect(recorded.updates.some((update) => update.data.status === TileStatus.failed)).toBe(false);
  });

  it('does not split for a trail that failed on its own account', async () => {
    /*
     * The gate is "the deadline refused work", not "a trail failed" and not "the clock is
     * past". Both production splits on 2026-08-05 (540,311 ms and 545,210 ms against a
     * 540,000 ms deadline) were 311 ms and 5.2 s late with nothing left to do, and splitting
     * there discards a finished tile to queue four children over work already in `trails`.
     *
     * The minimal fake below has no `trail` model, so `commitTrail` throws for a reason that is
     * not the clock — the tile fails and is retried whole, and no children are queued.
     */
    const { db, recorded } = fakeDb();
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;

    await expect(
      processTile(DENSE, {
        db,
        overpass,
        enrichWaypoints: false,
        deadlineAt: Date.now() + 600_000,
      }),
    ).rejects.toThrow(TRAIL_LOST_MARKER);

    expect(recorded.jobs).toEqual([]);
    expect(recorded.updates.at(-1)?.data.status).toBe(TileStatus.failed);
  });

  it('fails a tile at the floor, because there is nowhere left to split', async () => {
    const { db, recorded } = fakeDb();
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;

    await expect(
      processTile('12022120300', {
        db,
        overpass,
        enrichWaypoints: false,
        subdivideMaxZoom: MAX_INGEST_ZOOM,
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toThrow(/deadline/);

    expect(recorded.updates.at(-1)?.data.status).toBe(TileStatus.failed);
    expect(recorded.jobs).toEqual([]);
  });

  it('splits when Overpass runs out of clock on the tile query itself', async () => {
    // The other half of "this box is too big": a tile whose own query cannot be served inside
    // the budget never reaches the commit loop, so the deadline check after it never fires.
    const { db, recorded } = fakeDb();
    const overpass = {
      query: () => Promise.reject(new OverpassDeadlineError(1_000)),
    } as unknown as OverpassClient;

    const result = await processTile(DENSE, {
      db,
      overpass,
      subdivideMaxZoom: MAX_INGEST_ZOOM,
      deadlineAt: Date.now() + 60_000,
    });

    expect(result.children).toHaveLength(4);
    expect(recorded.jobs).toEqual(result.children.map((key) => `ingest_tile:${key}`));
    expect(recorded.updates.some((update) => update.data.status === TileStatus.failed)).toBe(false);
  });

  it('fails rather than splitting when Overpass is merely unavailable', async () => {
    // Subdividing on a breaker that is open would quadruple the load on a service already
    // refusing, and the tile is not the problem.
    const { db, recorded } = fakeDb();
    const overpass = {
      query: () => Promise.reject(new OverpassUnavailableError(30_000)),
    } as unknown as OverpassClient;

    await expect(
      processTile(DENSE, {
        db,
        overpass,
        subdivideMaxZoom: MAX_INGEST_ZOOM,
        deadlineAt: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/circuit breaker/);

    expect(recorded.jobs).toEqual([]);
    expect(recorded.updates.at(-1)?.data.status).toBe(TileStatus.failed);
  });

  it('never re-fetches a tile that has already been split', async () => {
    // `ensureCoverage` still queues the z9 parent and knows nothing about the split, so this
    // path runs on every viewport over subdivided ground. Asking Overpass again would spend
    // the invocation that subdivision exists to save.
    const children = ['1202212030', '1202212031', '1202212032', '1202212033'].map((quadkey) => ({
      quadkey,
      status: TileStatus.ready,
      fetchedAt: new Date(),
      trailCount: 7,
      fetchMs: 100,
    }));
    const { db, recorded } = fakeDb(children);
    let queried = false;
    const overpass = {
      query: async () => {
        queried = true;
        return { elements: [] };
      },
    } as unknown as OverpassClient;

    const result = await processTile(DENSE, { db, overpass });

    expect(queried).toBe(false);
    expect(result.status).toBe(TileStatus.ready);
    expect(result.trailCount).toBe(28);
    expect(recorded.updates).toEqual([
      {
        quadkey: DENSE,
        data: expect.objectContaining({ status: TileStatus.ready, trailCount: 28 }) as Record<
          string,
          unknown
        >,
      },
    ]);
  });

  it('keeps a parent that was serving trails in readyTiles when it splits', async () => {
    /*
     * Through `processTile`, not by calling `splitTile` with a hand-built row: the tile is
     * written `running` before the fetch, so a split that re-read the row would see `running`,
     * decide the parent had never served anything, and flip a reader from "here are your trails,
     * refreshing" to "still loading" for as long as four children take. That regression passed a
     * unit test for a whole round because the unit test never went through this path.
     */
    const { db, recorded } = fakeDb([
      { quadkey: DENSE, status: TileStatus.ready, fetchedAt: ago(TILE_TTL_MS + 1) },
    ]);
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;

    const result = await processTile(DENSE, {
      db,
      overpass,
      enrichWaypoints: false,
      subdivideMaxZoom: MAX_INGEST_ZOOM,
      deadlineAt: Date.now() - 1,
    });

    expect(result.children).toHaveLength(4);
    expect(recorded.updates.at(-1)).toEqual({
      quadkey: DENSE,
      data: expect.objectContaining({ status: TileStatus.ready }) as Record<string, unknown>,
    });
  });

  it('reports an exhausted descendant once, not on every drain', async () => {
    /*
     * The alert this feeds is Count > 0 over fifteen minutes with `autoMitigate` off, and a
     * blocked parent is `pending` — so `ensureCoverage` re-queues it on every viewport poll and
     * the client polls precisely *because* it is pending. A line per drain would page every
     * quarter of an hour for as long as anyone left that map open.
     */
    const children = ['1202212030', '1202212031', '1202212032', '1202212033'].map(
      (quadkey, index) => ({
        quadkey,
        status: index === 3 ? TileStatus.failed : TileStatus.ready,
        fetchedAt: index === 3 ? null : new Date(),
        trailCount: index === 3 ? 0 : 7,
        fetchMs: 100,
      }),
    );
    const { db } = fakeDb(
      [{ quadkey: DENSE, status: TileStatus.pending, lastError: null }, ...children],
      {
        'ingest_tile:1202212033': JobStatus.dead,
      },
    );
    const overpass = { query: async () => ({ elements: [] }) } as unknown as OverpassClient;
    const lines: string[] = [];
    const deps = { db, overpass, logger: (message: string) => lines.push(message) };

    await processTile(DENSE, deps);
    await processTile(DENSE, deps);

    expect(lines.filter((line) => line.includes(SUBTREE_STUCK_MARKER))).toHaveLength(1);
  });
});

describe('processTile, a trail that would not commit', () => {
  /**
   * A raster that answers every pixel with the same elevation, so a trail reaches the
   * transaction rather than being skipped for an all-gap profile.
   */
  const FLAT_TERRAIN: TerrariumTile = (() => {
    const encoded = 1_000 + 32_768;
    const pixel = [Math.floor(encoded / 256), encoded % 256, 0];
    return {
      z: 13,
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      channels: 3,
      data: Uint8Array.from([...pixel, ...pixel, ...pixel, ...pixel]),
    };
  })();

  /** Terrain that covers everything, so the commit is the only thing that can go wrong. */
  const flatTerrain = {
    tilesFor: () =>
      Promise.resolve({ get: () => FLAT_TERRAIN } as unknown as Map<string, TerrariumTile>),
  } as unknown as TerrainSource;

  /** Terrain that covers nothing: every sample is a gap, so the trail is skipped, not lost. */
  const noTerrain = {
    tilesFor: () => Promise.resolve(new Map<string, TerrariumTile>()),
  } as unknown as TerrainSource;

  /** Covers everything, slowly, so a deadline can pass while trails are still being prepared. */
  function slowTerrain(delayMs: number): TerrainSource {
    return {
      tilesFor: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ get: () => FLAT_TERRAIN }), delayMs);
        }),
    } as unknown as TerrainSource;
  }

  /**
   * The production failure, verbatim: 26 of the 30 non-deadline trail failures in the seven days
   * to 2026-08-09 carried this message, over 31.5-80.5 s against `TRAIL_TX_TIMEOUT_MS`.
   */
  function expiredTransaction(): Error {
    return new Error(
      'Transaction API error: Transaction already closed: A commit cannot be executed on an ' +
        'expired transaction. The timeout for this transaction was 30000 ms, however 39202 ms passed.',
    );
  }

  function timingOutTransaction(): PrismaClient {
    const { db, recorded } = fakeDb();
    (db as unknown as { $transaction: () => Promise<never> }).$transaction = () =>
      Promise.reject(expiredTransaction());
    return Object.assign(db, { recorded });
  }

  /**
   * A database that runs the batch transaction for real and refuses one named trail's row.
   *
   * The fixture the batch path needs: a stub that rejects `$transaction` outright cannot tell a
   * batch that lost one member from a batch that lost all of them, and "the good rows still
   * landed" is the whole claim the per-row fallback makes. `committed` collects the OSM ids that
   * reached `trail.upsert` without throwing.
   */
  function poisonedDb(poison: readonly number[]): PrismaClient {
    const { db, recorded } = fakeDb();
    const refuse = new Set(poison.map((id) => BigInt(id)));
    const committed: string[] = [];
    let batches = 0;
    // Rolled back on a throw, like the transaction it stands in for. Without this the rows
    // written before the poison one would count twice and the assertion would pass either way.
    let staged: string[] = [];

    const tx = {
      trail: {
        findMany: () => Promise.resolve([]),
        upsert: ({ where }: { where: { osmType_osmId: { osmId: bigint } } }) => {
          const osmId = where.osmType_osmId.osmId;
          if (refuse.has(osmId)) return Promise.reject(expiredTransaction());
          staged.push(osmId.toString());
          return Promise.resolve({ id: `trail-${osmId.toString()}` });
        },
        update: () => Promise.resolve({ id: 'trail-existing' }),
      },
      trailSlugAlias: { findMany: () => Promise.resolve([]) },
      elevationProfile: {
        deleteMany: () => Promise.resolve({ count: 0 }),
        createMany: () => Promise.resolve({ count: 0 }),
      },
      waypoint: {
        deleteMany: () => Promise.resolve({ count: 0 }),
        createMany: () => Promise.resolve({ count: 0 }),
      },
      $executeRaw: () => Promise.resolve(0),
    };

    (
      db as unknown as {
        $transaction: (body: (tx: unknown) => Promise<string[]>) => Promise<string[]>;
      }
    ).$transaction = async (body) => {
      batches += 1;
      staged = [];
      const ids = await body(tx);
      committed.push(...staged);
      return ids;
    };

    return Object.assign(db, {
      recorded,
      poisoned: { committed, batchCount: () => batches },
    });
  }

  /**
   * The claim the fallback makes, on its own, before any tile-level status is involved: a batch
   * that hits a bad row still lands every good one, and the bad one is named.
   */
  it('lands the good rows and names the bad one when a batch hits a poison row', async () => {
    const eight: OverpassElement[] = Array.from({ length: 8 }, (_, index) => ({
      type: 'way',
      id: 200 + index,
      tags: { highway: 'path', name: `Balcon ${String(index)}` },
      geometry: [
        { lat: 46.1 + index / 100, lon: 6.5 },
        { lat: 46.11 + index / 100, lon: 6.5 },
      ],
    }));

    const db = poisonedDb([203]);
    const { recorded, poisoned } = db as unknown as {
      recorded: Recorded;
      poisoned: { committed: string[]; batchCount: () => number };
    };
    const overpass = { query: async () => ({ elements: eight }) } as unknown as OverpassClient;

    await expect(
      processTile(DENSE, {
        db,
        overpass,
        terrain: flatTerrain,
        enrichWaypoints: false,
        deadlineAt: Date.now() + 600_000,
      }),
    ).rejects.toThrow(TRAIL_LOST_MARKER);

    // Seven landed and one is named — not "the batch failed".
    expect(poisoned.committed.sort()).toEqual(
      ['200', '201', '202', '204', '205', '206', '207'].sort(),
    );
    const lastError = String(recorded.updates.at(-1)?.data.lastError);
    expect(lastError).toContain('1 of 8 trail(s) did not commit');
    expect(lastError).toContain('way/203');
    expect(lastError).not.toContain('way/204');
    expect(recorded.updates.at(-1)?.data.trailCount).toBe(7);

    // One batch attempt, then eight single-row writes. The compute never repeats.
    expect(poisoned.batchCount()).toBe(9);
  });

  /** Two named ways, so a fixture can commit one and lose the other. */
  const twoTrails: OverpassElement[] = [
    ...oneTrail,
    {
      type: 'way',
      id: 43,
      tags: { highway: 'path', name: 'Grand Balcon Nord' },
      geometry: [
        { lat: 46.2, lon: 6.6 },
        { lat: 46.21, lon: 6.6 },
      ],
    },
  ];

  /**
   * One trail commits, the next hits the expiry. The only shape that separates "this tile lost
   * ground" from "this tile committed nothing": with a single-trail fixture `committed` is zero
   * whenever `failed` is one, so a gate reading either count alone behaves identically.
   */
  function oneCommitOneExpiry(): PrismaClient {
    return poisonedDb([43]);
  }

  it('fails a tile that committed most of its trails and lost one', async () => {
    /*
     * The half of the contract a single-trail fixture cannot reach. Tile 1202212023 committed
     * 900 and lost six; a gate that fired only when *nothing* committed would write `ready`
     * over that hole and — unlike the behaviour this replaces — without even a `lastError`.
     */
    const db = oneCommitOneExpiry();
    const { recorded } = db as unknown as { recorded: Recorded };
    const overpass = { query: async () => ({ elements: twoTrails }) } as unknown as OverpassClient;

    await expect(
      processTile(DENSE, {
        db,
        overpass,
        terrain: flatTerrain,
        enrichWaypoints: false,
        deadlineAt: Date.now() + 600_000,
      }),
    ).rejects.toThrow(TRAIL_LOST_MARKER);

    const last = recorded.updates.at(-1);
    expect(last?.data.status).toBe(TileStatus.failed);
    expect(last?.data.fetchedAt).toBeUndefined();
    // One trail did commit: the fixture is mixed, not another all-fail case.
    expect(last?.data.trailCount).toBe(1);
    expect(String(last?.data.lastError)).toContain('1 of 2 trail(s) did not commit');
    expect(String(last?.data.lastError)).toContain('way/43');
    expect(String(last?.data.lastError)).not.toContain('way/42');
  });

  it('refuses to report ready with a trail it could not commit', async () => {
    /*
     * Tile 1202212023 in production: `status=ready, trailCount=900`, and four of the six trails
     * its log named have no row in `trails` at all. `ready` plus `fetchedAt` is what
     * `isTileFresh` sells to `ensureCoverage`, so that write bought `TILE_TTL_MS` of silence
     * over ground with holes in it.
     */
    const db = timingOutTransaction();
    const { recorded } = db as unknown as { recorded: Recorded };
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;

    await expect(
      processTile(DENSE, {
        db,
        overpass,
        terrain: flatTerrain,
        enrichWaypoints: false,
        deadlineAt: Date.now() + 600_000,
      }),
    ).rejects.toThrow(/39202 ms passed|did not commit/);

    const last = recorded.updates.at(-1);
    expect(last?.data.status).toBe(TileStatus.failed);
    expect(last?.data.fetchedAt).toBeUndefined();
  });

  it('names the tile and the trail on the row an operator reads', async () => {
    // `failJob` copies the thrown message onto the job row, so one token has to reach the tile
    // row, the job row and the log for the three to be correlatable.
    const db = timingOutTransaction();
    const { recorded } = db as unknown as { recorded: Recorded };
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;
    const lines: string[] = [];

    await expect(
      processTile(DENSE, {
        db,
        overpass,
        terrain: flatTerrain,
        enrichWaypoints: false,
        logger: (message: string) => lines.push(message),
      }),
    ).rejects.toThrow(TRAIL_LOST_MARKER);

    const lastError = String(recorded.updates.at(-1)?.data.lastError);
    expect(lastError).toContain(TRAIL_LOST_MARKER);
    expect(lastError).toContain(DENSE);
    expect(lastError).toContain('way/42');
    expect(lines.some((line) => line.includes(TRAIL_LOST_MARKER))).toBe(true);
  });

  it('names the lost trail even when the clock is what failed the tile', async () => {
    /*
     * A tile can run out of clock *and* lose a trail. The clock decides its fate, so it exits
     * through the deadline branch — and until that branch carried the ids, the one tile that
     * hit both failures was the only one whose missing ground was never named anywhere.
     *
     * At the zoom floor, so there is nowhere to split and the tile fails rather than
     * subdividing. Preparation is slower than the deadline and there are more trails than
     * `COMMIT_CONCURRENCY`, so the tail is refused by the clock while `way/100` is lost on its
     * own account.
     */
    const many: OverpassElement[] = Array.from({ length: 8 }, (_, index) => ({
      type: 'way',
      id: 100 + index,
      tags: { highway: 'path', name: `Balcon ${String(index)}` },
      geometry: [
        { lat: 46.1 + index / 100, lon: 6.5 },
        { lat: 46.11 + index / 100, lon: 6.5 },
      ],
    }));

    const db = poisonedDb([100]);
    const { recorded } = db as unknown as { recorded: Recorded };
    const overpass = { query: async () => ({ elements: many }) } as unknown as OverpassClient;
    const lines: string[] = [];

    await expect(
      processTile('12022120300', {
        db,
        overpass,
        terrain: slowTerrain(150),
        enrichWaypoints: false,
        subdivideMaxZoom: MAX_INGEST_ZOOM,
        deadlineAt: Date.now() + 100,
        logger: (message: string) => lines.push(message),
      }),
    ).rejects.toThrow(/deadline/);

    const lastError = String(recorded.updates.at(-1)?.data.lastError);
    expect(recorded.updates.at(-1)?.data.status).toBe(TileStatus.failed);
    // Both facts on the one row `failJob` copies to the job: the clock, and the trail.
    expect(lastError).toContain('deadline');
    expect(lastError).toContain(TRAIL_LOST_MARKER);
    expect(lastError).toContain('way/100');
    expect(lines.some((line) => line.includes(TRAIL_LOST_MARKER))).toBe(true);
  });

  it('carries the lost trail onto the parent row when the tile splits', async () => {
    /*
     * The shape production takes. Over the seven days to 2026-08-09 ten tile-invocations lost a
     * trail for a reason that was not the clock; five of them also ran out of clock, and all five
     * were z9 against a live ceiling of z11 — so every one took the split branch, not the floor
     * branch. `splitTile` is the last write to the parent, so an id that reaches only the log
     * line reaches nothing an operator queries.
     */
    const many: OverpassElement[] = Array.from({ length: 8 }, (_, index) => ({
      type: 'way',
      id: 100 + index,
      tags: { highway: 'path', name: `Balcon ${String(index)}` },
      geometry: [
        { lat: 46.1 + index / 100, lon: 6.5 },
        { lat: 46.11 + index / 100, lon: 6.5 },
      ],
    }));

    const db = poisonedDb([100]);
    const { recorded } = db as unknown as { recorded: Recorded };
    const overpass = { query: async () => ({ elements: many }) } as unknown as OverpassClient;
    const lines: string[] = [];

    // z9 against a z11 ceiling: `canSubdivide` is true, so this returns rather than throwing.
    const result = await processTile(DENSE, {
      db,
      overpass,
      terrain: slowTerrain(150),
      enrichWaypoints: false,
      subdivideMaxZoom: MAX_INGEST_ZOOM,
      deadlineAt: Date.now() + 100,
      logger: (message: string) => lines.push(message),
    });

    expect(result.status).toBe(TileStatus.pending);
    expect(result.children).toHaveLength(4);

    const parent = recorded.updates.filter((update) => update.quadkey === DENSE).at(-1);
    const lastError = String(parent?.data.lastError);
    // The split marker stays the prefix `reconcileOrphanedSplits` sweeps on, and the ids ride
    // behind it on the one row that survives the return.
    expect(lastError).toContain(SPLIT_MARKER_PREFIX);
    expect(lastError.startsWith(SPLIT_MARKER_PREFIX)).toBe(true);
    expect(lastError).toContain(TRAIL_LOST_MARKER);
    expect(lastError).toContain('way/100');
    expect(lines.some((line) => line.includes(TILE_SPLIT_MARKER))).toBe(true);
  });

  it('still reports ready when the tile skipped a trail rather than losing it', async () => {
    /*
     * A skip is a decision — no terrain under the line, a resample too short to be a trail, a
     * relation another tile owns — and the tile has covered its ground. Keying the refusal on
     * "committed fewer than we assembled" would fail every tile over open water.
     */
    const { db, recorded } = fakeDb();
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;

    const result = await processTile(DENSE, {
      db,
      overpass,
      terrain: noTerrain,
      enrichWaypoints: false,
    });

    expect(result).toMatchObject({ status: TileStatus.ready, skipped: 1, failed: 0 });
    expect(recorded.updates.at(-1)?.data.status).toBe(TileStatus.ready);
  });
});

describe('chooseHero', () => {
  /**
   * A database reduced to the three facts this decision reads: who owns each photo, which
   * photo each trail is currently flying as its hero, and which photos a moderator has taken
   * down.
   */
  function fakeDb(
    owners: Record<string, string>,
    heroes: Record<string, string>,
    hidden: readonly string[] = [],
  ): PrismaClient {
    const isHidden = new Set(hidden);
    return {
      photo: {
        findUnique: ({ where }: { where: { id: string } }) => {
          const owner = owners[where.id];
          return Promise.resolve(
            owner === undefined
              ? null
              : { trailId: owner, hiddenAt: isHidden.has(where.id) ? new Date() : null },
          );
        },
        findMany: ({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(where.id.in.filter((id) => !isHidden.has(id)).map((id) => ({ id }))),
      },
      trail: {
        findMany: ({
          where,
        }: {
          where: { id: { not: string }; primaryPhotoId: { in: string[] } };
        }) =>
          Promise.resolve(
            Object.entries(heroes)
              .filter(
                ([trailId, photoId]) =>
                  trailId !== where.id.not && where.primaryPhotoId.in.includes(photoId),
              )
              .map(([, photoId]) => ({ primaryPhotoId: photoId })),
          ),
      },
    } as unknown as PrismaClient;
  }

  it('keeps a hero the trail already owns', async () => {
    // The guarantee that matters to a user: a photograph they uploaded and chose outranks
    // anything we scraped, and re-running enrichment must not quietly take it back.
    const db = fakeDb({ mine: 'trail_a' }, { trail_a: 'mine' });
    await expect(chooseHero(db, 'trail_a', 'mine', ['fresh_1', 'fresh_2'])).resolves.toBe('mine');
  });

  it('takes back a hero that belongs to a different trail', async () => {
    // The visible half of the re-parenting bug: a pointer left behind when the old upsert key
    // moved a shared Commons photo to a neighbour is a picture of somewhere else at the top
    // of this trail's page. It is not a preference worth preserving.
    const db = fakeDb({ stolen: 'trail_b', fresh_1: 'trail_a' }, { trail_a: 'stolen' });
    await expect(chooseHero(db, 'trail_a', 'stolen', ['fresh_1'])).resolves.toBe('fresh_1');
  });

  it('steps over a candidate another trail has already claimed', async () => {
    // `Trail.primaryPhotoId` is `@unique`, so claiming a photo somebody else is flying is not
    // a cosmetic mistake — it is a unique violation that aborts the whole update, losing the
    // photo count alongside the hero. This is what killed fourteen enrichment jobs.
    const db = fakeDb({}, { trail_b: 'fresh_1' });
    await expect(chooseHero(db, 'trail_a', null, ['fresh_1', 'fresh_2'])).resolves.toBe('fresh_2');
  });

  it('clears rather than rewrites when every candidate is spoken for', async () => {
    const db = fakeDb({ stolen: 'trail_b' }, { trail_a: 'stolen', trail_b: 'fresh_1' });
    await expect(chooseHero(db, 'trail_a', 'stolen', ['fresh_1'])).resolves.toBeNull();
  });

  it('leaves a trail with nothing to show heroless', async () => {
    await expect(chooseHero(fakeDb({}, {}), 'trail_a', null, [])).resolves.toBeNull();
  });

  it('drops a pointer at a photo that no longer exists', async () => {
    // Belt and braces against a hero whose row went away without the foreign key firing.
    const db = fakeDb({ fresh_1: 'trail_a' }, {});
    await expect(chooseHero(db, 'trail_a', 'vanished', ['fresh_1'])).resolves.toBe('fresh_1');
  });

  it('moves the hero off a photograph a moderator took down', async () => {
    // Without this the "keep what the trail already owns" rule above re-pins hidden content
    // to the top of the trail page on the next enrich pass — the most visible place on the
    // site, and the one where an undone takedown would be noticed last, because nothing
    // recomputes the hero again until somebody uploads.
    const db = fakeDb({ removed: 'trail_a', fresh_1: 'trail_a' }, { trail_a: 'removed' }, [
      'removed',
    ]);
    await expect(chooseHero(db, 'trail_a', 'removed', ['fresh_1'])).resolves.toBe('fresh_1');
  });

  it('will not promote a hidden candidate into the empty slot', async () => {
    // The other direction: having correctly moved off the removed hero, it must not pick
    // another removed one to replace it with.
    const db = fakeDb({}, {}, ['fresh_1']);
    await expect(chooseHero(db, 'trail_a', null, ['fresh_1', 'fresh_2'])).resolves.toBe('fresh_2');
  });

  it('leaves the trail heroless when every candidate has been taken down', async () => {
    const db = fakeDb({}, {}, ['fresh_1', 'fresh_2']);
    await expect(chooseHero(db, 'trail_a', null, ['fresh_1', 'fresh_2'])).resolves.toBeNull();
  });
});

describe('fetchWayGeometries', () => {
  /**
   * A mirror that refuses any request for more than `limit` ways at once.
   *
   * This is the real failure, not an invented one: the batch size is a guess about what a
   * mirror will serve, and on a dense PCT section the same 250 ways are a far heavier
   * response than in open desert. The mirror answers 504, and before this halving existed
   * that single timeout failed the entire 4,270 km route.
   */
  function mirror(limit: number): { overpass: OverpassClient; batches: number[][] } {
    const batches: number[][] = [];
    const overpass = {
      query: (query: string) => {
        const ids = /way\(id:([\d,]+)\)/u.exec(query)![1]!.split(',').map(Number);
        batches.push(ids);
        if (ids.length > limit) return Promise.reject(new Error('Overpass 504'));
        return Promise.resolve({
          elements: ids.map((id) => ({ type: 'way', id, geometry: [{ lat: id, lon: id }] })),
        });
      },
    } as unknown as OverpassClient;
    return { overpass, batches };
  }

  const silent = () => {};
  const IDS = [1, 2, 3, 4, 5, 6, 7];

  it('takes a batch whole when the mirror will serve it', async () => {
    const { overpass, batches } = mirror(Infinity);
    const geometries = await fetchWayGeometries(IDS, { overpass }, silent, 1, 99);

    expect(batches).toHaveLength(1);
    expect([...geometries.keys()].sort((a, b) => a - b)).toEqual(IDS);
  });

  it('halves a batch the mirror refuses rather than failing the route', async () => {
    const { overpass, batches } = mirror(4);
    const geometries = await fetchWayGeometries(IDS, { overpass }, silent, 1, 99);

    // Every way still arrives — which is the whole point. A route is committed whole or
    // not at all, so "most of the ways" would be worse than useless.
    expect([...geometries.keys()].sort((a, b) => a - b)).toEqual(IDS);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0]).toEqual(IDS);
  });

  it('descends to single ways when the mirror is refusing almost everything', async () => {
    const { overpass, batches } = mirror(1);
    const geometries = await fetchWayGeometries(IDS, { overpass }, silent, 1, 99);

    expect([...geometries.keys()].sort((a, b) => a - b)).toEqual(IDS);
    // Each id eventually asked for on its own, and none skipped on the way down.
    const singles = batches.filter((batch) => batch.length === 1).flat();
    expect(singles.sort((a, b) => a - b)).toEqual(IDS);
  });

  it('gives up on a single way, because there is nothing smaller to ask for', async () => {
    // The floor. Below a way Overpass has no smaller unit, so this is a genuine gap rather
    // than a size problem — and a gap has to be fatal or the route lies about its length.
    const { overpass } = mirror(0);
    await expect(fetchWayGeometries([1, 2], { overpass }, silent, 1, 99)).rejects.toThrow(/504/u);
  });

  it('does not re-ask for ways it already holds after a partial failure', async () => {
    const { overpass, batches } = mirror(2);
    await fetchWayGeometries(IDS, { overpass }, silent, 1, 99);

    // Halving must partition, not overlap: a batch retried as two halves that both contain
    // the same id would multiply requests against a mirror that is already struggling.
    const succeeded = batches.filter((batch) => batch.length <= 2).flat();
    expect(new Set(succeeded).size).toBe(succeeded.length);
  });
});

describe('assignSlugs', () => {
  const OSM_ID = 162652736n;
  const LADDER = slugLadder('Kibbie Lake Trail', 'Tuolumne', OsmElementType.way, OSM_ID);

  function want(candidates: readonly string[] = LADDER, osmId = OSM_ID): SlugWant {
    return { osmType: OsmElementType.way, osmId, candidates };
  }

  /** A transaction client holding the given trails, and answering the alias lookup as told. */
  function txWith(
    retired: readonly string[],
    options: {
      trails?: ReadonlyArray<{
        slug: string;
        osmType: OsmElementType | null;
        osmId: bigint | null;
      }>;
      aliasLookup?: () => Promise<never>;
    } = {},
  ): Prisma.TransactionClient {
    return {
      trail: { findMany: () => Promise.resolve(options.trails ?? []) },
      trailSlugAlias: {
        findMany:
          options.aliasLookup ??
          (({ where }: { where: { slug: { in: string[] } } }) =>
            Promise.resolve(
              where.slug.in.filter((slug) => retired.includes(slug)).map((slug) => ({ slug })),
            )),
      },
    } as unknown as Prisma.TransactionClient;
  }

  function rejectWith(code: string): () => Promise<never> {
    return () =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion: 'test' }),
      );
  }

  it('takes the bare name when no trail and no alias hold it', async () => {
    expect(await assignSlugs(txWith([]), [want()])).toEqual(['kibbie-lake-trail']);
  });

  it('steps past a slug a merge retired, so a permanent link keeps its own trail', async () => {
    expect(await assignSlugs(txWith(['kibbie-lake-trail']), [want()])).toEqual([
      'kibbie-lake-trail-tuolumne',
    ]);
  });

  it('keeps a slug the same trail already holds, so a re-ingest keeps its URL', async () => {
    const tx = txWith([], {
      trails: [{ slug: 'kibbie-lake-trail', osmType: OsmElementType.way, osmId: OSM_ID }],
    });
    expect(await assignSlugs(tx, [want()])).toEqual(['kibbie-lake-trail']);
  });

  it('steps past a slug a different trail holds', async () => {
    const tx = txWith([], {
      trails: [{ slug: 'kibbie-lake-trail', osmType: OsmElementType.way, osmId: 99n }],
    });
    expect(await assignSlugs(tx, [want()])).toEqual(['kibbie-lake-trail-tuolumne']);
  });

  /*
   * The reason this function exists rather than a ladder walk per trail. Both reads happen
   * before either trail is written, so nothing in the database distinguishes them: without the
   * in-batch reservation both take `kibbie-lake-trail` and the batch dies on the unique index.
   */
  it('does not hand one free name to two trails in the same batch', async () => {
    const other = 900123n;
    const slugs = await assignSlugs(txWith([]), [
      want(),
      want(slugLadder('Kibbie Lake Trail', 'Tuolumne', OsmElementType.way, other), other),
    ]);
    expect(slugs[0]).toBe('kibbie-lake-trail');
    expect(slugs[1]).toBe('kibbie-lake-trail-tuolumne');
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  /*
   * The last rung is the only one unique by construction, and the only one carrying `osmType`.
   * A trail whose first three rungs all belong to somebody else has to reach it rather than
   * take a name that is not its own.
   */
  it('falls to the rung carrying osmType when every earlier one is taken', async () => {
    const tx = txWith([], {
      trails: LADDER.slice(0, 3).map((slug) => ({
        slug,
        osmType: OsmElementType.way,
        osmId: 99n,
      })),
    });
    expect(await assignSlugs(tx, [want()])).toEqual([
      `kibbie-lake-trail-way-${OSM_ID.toString(36)}`,
    ]);
  });

  // The property `osm-id` is documented to have: no dependency on `trail_slug_aliases` existing.
  // A Preview build runs branch code against whichever database it is pointed at while `migrate`
  // runs on `master` alone, so without this the whole commit fails there rather than ingesting.
  it('ingests against a database that has no trail_slug_aliases at all', async () => {
    const tx = txWith([], { aliasLookup: rejectWith('P2021') });
    expect(await assignSlugs(tx, [want()])).toEqual(['kibbie-lake-trail']);
  });

  it('still fails the commit on an error that is not a missing table', async () => {
    const tx = txWith([], { aliasLookup: rejectWith('P1010') });
    await expect(assignSlugs(tx, [want()])).rejects.toMatchObject({ code: 'P1010' });
  });
});

describe('planCommitBatches', () => {
  function trail(osmId: number, memberWayIds: number[]): AssembledTrail {
    return {
      osmType: 'way',
      osmId,
      name: `Trail ${osmId}`,
      tags: {},
      coords: [
        [0, 0],
        [1, 1],
      ],
      bbox: [0, 0, 1, 1],
      lengthM: 100,
      bridgedM: 0,
      memberWayIds,
    };
  }

  it('fills a batch to the cap and no further', () => {
    const trails = Array.from({ length: 7 }, (_, i) => trail(i, [i]));
    expect(planCommitBatches(trails, 3).map((batch) => batch.length)).toEqual([3, 3, 1]);
  });

  /*
   * The invariant `writeCommitBatch`'s single claim read depends on. Two trails sharing a way
   * have to see each other's insert to arbitrate, and one batch-wide read cannot show that.
   * Tile 021231030 has three such ways among 144 trails, so this is reachable.
   */
  it('closes a batch rather than put two claimants of one way in it', () => {
    const batches = planCommitBatches([trail(1, [10, 11]), trail(2, [11, 12]), trail(3, [13])], 25);
    expect(batches.map((batch) => batch.map((entry) => entry.osmId))).toEqual([[1], [2, 3]]);
  });

  it('leaves a trail with no member ways free to share any batch', () => {
    const batches = planCommitBatches([trail(1, []), trail(2, []), trail(3, [])], 25);
    expect(batches).toHaveLength(1);
  });
});
