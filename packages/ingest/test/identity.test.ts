/**
 * Trail identity across a tile seam. The seam fixture is the point: two adjacent tiles assemble
 * the same physical trail from overlapping way sets, and nothing but the ways tells them so.
 */

import { describe, expect, it } from 'vitest';
import { OsmElementType } from '@switchback/db';
import type { Prisma } from '@switchback/db';
import { assembleTrails } from '../src/assemble';
import type { AssembledTrail } from '../src/assemble';
import type { OverpassElement } from '../src/overpass';
import { ClaimConflictError, claimWays, resolveTrail, trailIdentityMode } from '../src/identity';

/** The real boundary between `120230203` and `120230212`, the two tiles observed splitting. */
const SEAM_LNG = 12.65625;
const LAT = 46.3;
const TRAIL_NAME = 'Seam Ridge Trail';

interface Claim {
  wayId: number;
  id: string;
  name?: string;
  osmType: OsmElementType | null;
  createdAt: string;
}

/** A transaction client that answers `trailWay.findMany` from a fixed claim list. */
function txWith(claims: readonly Claim[]): Prisma.TransactionClient {
  return {
    trailWay: {
      findMany: ({ where }: { where: { wayId: { in: bigint[] } } }) => {
        const asked = where.wayId.in.map((id) => Number(id));
        return Promise.resolve(
          claims
            .filter((claim) => asked.includes(claim.wayId))
            .map((claim) => ({
              trail: {
                id: claim.id,
                name: claim.name ?? TRAIL_NAME,
                osmType: claim.osmType,
                createdAt: new Date(claim.createdAt),
              },
            })),
        );
      },
    },
  } as unknown as Prisma.TransactionClient;
}

/** Records what `claimWays` wrote, and answers its read from `held`. */
function claimTx(held: Record<number, string>) {
  const inserted: Array<{ wayId: number; trailId: string }> = [];
  const repointed: Array<{ wayIds: number[]; trailId: string }> = [];
  const trailWay = {
    findMany: ({ where }: { where: { wayId: { in: bigint[] } } }) =>
      Promise.resolve(
        where.wayId.in
          .filter((id) => held[Number(id)] !== undefined)
          .map((id) => ({ wayId: id, trailId: held[Number(id)]! })),
      ),
    createMany: ({ data }: { data: Array<{ wayId: bigint; trailId: string }> }) => {
      for (const row of data) inserted.push({ wayId: Number(row.wayId), trailId: row.trailId });
      return Promise.resolve({ count: data.length });
    },
    updateMany: (args: { where: { wayId: { in: bigint[] } }; data: { trailId: string } }) => {
      repointed.push({ wayIds: args.where.wayId.in.map(Number), trailId: args.data.trailId });
      return Promise.resolve({ count: args.where.wayId.in.length });
    },
  };
  return { trailWay, tx: { trailWay } as unknown as Prisma.TransactionClient, inserted, repointed };
}

function way(id: number, from: number, to: number): OverpassElement {
  return {
    type: 'way',
    id,
    tags: { name: TRAIL_NAME, highway: 'path' },
    geometry: [
      { lat: LAT, lon: from },
      { lat: LAT, lon: to },
    ],
  };
}

/** What `resolveTrail` needs off an assembly. */
function claimInput(trail: AssembledTrail) {
  return { osmType: trail.osmType, name: trail.name, memberWayIds: trail.memberWayIds };
}

// Way 300 crosses the seam, so Overpass returns it whole to both tiles: `buildTileQuery` filters
// per statement and sets no global `[bbox:]`, which is what makes the shared claim possible.
const WEST_ONLY = way(700, SEAM_LNG - 0.06, SEAM_LNG - 0.03);
const STRADDLING = way(300, SEAM_LNG - 0.03, SEAM_LNG + 0.03);
const EAST_ONLY = way(100, SEAM_LNG + 0.03, SEAM_LNG + 0.06);

describe('the seam this exists to close', () => {
  it('gives one trail two different osmIds and one shared way', () => {
    const west = assembleTrails([WEST_ONLY, STRADDLING]);
    const east = assembleTrails([STRADDLING, EAST_ONLY]);

    expect(west).toHaveLength(1);
    expect(east).toHaveLength(1);

    // `Math.min(...wayIds)` over each tile's own subset — the key `commitTrail` upserts on, and
    // the reason one trail becomes two rows that collide on nothing.
    expect(west[0]!.osmId).toBe(300);
    expect(east[0]!.osmId).toBe(100);
    expect(west[0]!.osmId).not.toBe(east[0]!.osmId);

    // What does survive subdivision: both sides carry the straddling way.
    const shared = west[0]!.memberWayIds.filter((id) => east[0]!.memberWayIds.includes(id));
    expect(shared).toEqual([300]);
  });

  it('resolves both halves onto the row the first tile created', async () => {
    const west = assembleTrails([WEST_ONLY, STRADDLING])[0]!;
    const east = assembleTrails([STRADDLING, EAST_ONLY])[0]!;

    expect(await resolveTrail(txWith([]), claimInput(west))).toEqual({
      kind: 'create',
      claim: 'fail',
    });

    const afterWest = txWith(
      west.memberWayIds.map((wayId) => ({
        wayId,
        id: 'trail-west',
        osmType: OsmElementType.way,
        createdAt: '2026-08-01T00:00:00Z',
      })),
    );
    expect(await resolveTrail(afterWest, claimInput(east))).toEqual({
      kind: 'adopt',
      trailId: 'trail-west',
      claim: 'fail',
    });
  });
});

describe('resolveTrail', () => {
  const wayTrail = { osmType: 'way' as const, name: TRAIL_NAME, memberWayIds: [1, 2, 3] };

  it('creates when nothing has claimed the ways, or there are none to claim', async () => {
    expect(await resolveTrail(txWith([]), wayTrail)).toEqual({ kind: 'create', claim: 'fail' });
    expect(await resolveTrail(txWith([]), { ...wayTrail, memberWayIds: [] })).toEqual({
      kind: 'create',
      claim: 'fail',
    });
  });

  it('merges into the oldest claimant and names the rest for retirement', async () => {
    const resolution = await resolveTrail(
      txWith([
        { wayId: 1, id: 'newer', osmType: OsmElementType.way, createdAt: '2026-08-02T00:00:00Z' },
        { wayId: 2, id: 'oldest', osmType: OsmElementType.way, createdAt: '2026-08-01T00:00:00Z' },
        { wayId: 3, id: 'newest', osmType: OsmElementType.way, createdAt: '2026-08-03T00:00:00Z' },
      ]),
      wayTrail,
    );
    expect(resolution).toEqual({
      kind: 'merge',
      trailId: 'oldest',
      retiredIds: ['newer', 'newest'],
      claim: 'fail',
    });
  });

  it('picks the same winner from the same set whichever tile asks', async () => {
    // Identical timestamps are what a bulk backfill produces; without the id tiebreak two
    // tiles racing would each keep their own row and neither would ever converge.
    const tied = (order: number[]) =>
      txWith(
        order.map((wayId, index) => ({
          wayId,
          id: `trail-${String.fromCharCode(97 + index)}`,
          osmType: OsmElementType.way,
          createdAt: '2026-08-01T00:00:00Z',
        })),
      );
    const first = await resolveTrail(tied([1, 2, 3]), wayTrail);
    const second = await resolveTrail(tied([3, 2, 1]), wayTrail);
    expect(first).toHaveProperty('trailId', 'trail-a');
    expect(second).toHaveProperty('trailId', 'trail-a');
  });

  it('yields to a relation that names the way as its own', async () => {
    // Extends the rule `assembleTrails` applies inside one tile — a named way carrying its
    // relation's name is a fragment of it — to the tile that only sees the way.
    const resolution = await resolveTrail(
      txWith([
        {
          wayId: 1,
          id: 'way-trail',
          osmType: OsmElementType.way,
          createdAt: '2026-08-01T00:00:00Z',
        },
        {
          wayId: 2,
          id: 'the-route',
          name: '  seam   RIDGE trail ',
          osmType: OsmElementType.relation,
          createdAt: '2026-08-03T00:00:00Z',
        },
      ]),
      wayTrail,
    );
    expect(resolution).toEqual({ kind: 'skip', trailId: 'the-route' });
  });

  it('keeps a named way that a relation carries under another name', async () => {
    // The Mist Trail inside the John Muir Trail. `assembleTrails` requires membership *and* a
    // matching name before it drops a way; dropping on membership alone makes a real trail
    // unsearchable, and leaves no trace that it happened.
    const resolution = await resolveTrail(
      txWith([
        {
          wayId: 2,
          id: 'john-muir',
          name: 'John Muir Trail',
          osmType: OsmElementType.relation,
          createdAt: '2026-08-01T00:00:00Z',
        },
      ]),
      { osmType: 'way', name: 'Mist Trail', memberWayIds: [1, 2, 3] },
    );
    // `yield`, not `fail`: the relation owns way 2 legitimately, so this trail must not spend
    // every ingest fighting it for the claim.
    expect(resolution).toEqual({ kind: 'create', claim: 'yield' });
  });

  it('never routes a relation through claims, so a superroute cannot swallow its members', async () => {
    const claimed = txWith([
      { wayId: 1, id: 'a-member', osmType: OsmElementType.way, createdAt: '2026-08-01T00:00:00Z' },
    ]);
    const resolution = await resolveTrail(claimed, {
      osmType: 'relation',
      name: 'Big Route',
      memberWayIds: [1, 2, 3],
    });
    expect(resolution).toEqual({ kind: 'create', claim: 'take' });
  });
});

describe('claimWays', () => {
  it('refuses to overwrite another trail under `fail`, which is the concurrency control', async () => {
    const { tx, inserted } = claimTx({ 2: 'someone-else' });
    await expect(claimWays(tx, 'mine', [1, 2, 3], 'fail')).rejects.toBeInstanceOf(
      ClaimConflictError,
    );
    expect(inserted).toEqual([]);
  });

  it('reports a conflict the read missed, because the primary key is what settles it', async () => {
    const { trailWay } = claimTx({});
    const racing = {
      trailWay: {
        ...trailWay,
        createMany: () => Promise.reject(Object.assign(new Error('dup'), { code: 'P2002' })),
      },
    } as unknown as Prisma.TransactionClient;
    await expect(claimWays(racing, 'mine', [1], 'fail')).rejects.toBeInstanceOf(ClaimConflictError);
  });

  it('leaves another trail alone under `yield` and takes only what is free', async () => {
    const { tx, inserted, repointed } = claimTx({ 2: 'someone-else' });
    await claimWays(tx, 'mine', [1, 2, 3], 'yield');
    expect(inserted).toEqual([
      { wayId: 1, trailId: 'mine' },
      { wayId: 3, trailId: 'mine' },
    ]);
    expect(repointed).toEqual([]);
  });

  it('repoints under `take`, which is how a relation reclaims its members', async () => {
    const { tx, inserted, repointed } = claimTx({ 2: 'someone-else' });
    await claimWays(tx, 'the-route', [1, 2], 'take');
    expect(repointed).toEqual([{ wayIds: [2], trailId: 'the-route' }]);
    expect(inserted).toEqual([{ wayId: 1, trailId: 'the-route' }]);
  });

  it('re-claims nothing it already holds', async () => {
    const { tx, inserted, repointed } = claimTx({ 1: 'mine', 2: 'mine' });
    await claimWays(tx, 'mine', [1, 2], 'fail');
    expect(inserted).toEqual([]);
    expect(repointed).toEqual([]);
  });
});

describe('trailIdentityMode', () => {
  it('resolves through claims only when asked to, and defaults to the pre-claim upsert', () => {
    expect(trailIdentityMode({ INGEST_TRAIL_IDENTITY: 'claim' })).toBe('claim');
    for (const value of [undefined, '', 'osm-id', 'Claim', 'true', 'yes']) {
      expect(trailIdentityMode(value === undefined ? {} : { INGEST_TRAIL_IDENTITY: value })).toBe(
        'osm-id',
      );
    }
  });
});
