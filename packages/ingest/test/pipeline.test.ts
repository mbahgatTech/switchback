import { describe, expect, it } from 'vitest';
import { TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  TILE_TTL_MS,
  chooseHero,
  fetchWayGeometries,
  isTileFresh,
  pickRegion,
  processTile,
} from '../src/pipeline';
import type { OverpassClient, OverpassElement } from '../src/overpass';
import { OverpassDeadlineError, OverpassUnavailableError } from '../src/overpass';

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

describe('processTile, out of clock', () => {
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

  function fakeDb(children: Array<Record<string, unknown>> = []): {
    db: PrismaClient;
    recorded: Recorded;
  } {
    const recorded: Recorded = { updates: [], upserts: [], jobs: [] };
    const db = {
      ingestTile: {
        findMany: ({ where }: { where: { quadkey: { in: string[] } } }) =>
          Promise.resolve(
            children.filter((row) => where.quadkey.in.includes(row.quadkey as string)),
          ),
        upsert: (args: { where: { quadkey: string } }) => {
          recorded.upserts.push(args.where.quadkey);
          return Promise.resolve({});
        },
        update: (args: { where: { quadkey: string }; data: Record<string, unknown> }) => {
          recorded.updates.push({ quadkey: args.where.quadkey, data: args.data });
          return Promise.resolve({});
        },
      },
      ingestJob: {
        updateMany: () => Promise.resolve({ count: 0 }),
        upsert: (args: { where: { dedupeKey: string } }) => {
          recorded.jobs.push(args.where.dedupeKey);
          return Promise.resolve({});
        },
      },
    } as unknown as PrismaClient;
    return { db, recorded };
  }

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

  it('fails a tile at the floor, because there is nowhere left to split', async () => {
    const { db, recorded } = fakeDb();
    const overpass = { query: async () => ({ elements: oneTrail }) } as unknown as OverpassClient;

    await expect(
      processTile('12022120300', {
        db,
        overpass,
        enrichWaypoints: false,
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

    const result = await processTile(DENSE, { db, overpass, deadlineAt: Date.now() + 60_000 });

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
      processTile(DENSE, { db, overpass, deadlineAt: Date.now() + 60_000 }),
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
