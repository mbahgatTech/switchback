/**
 * Trail identity across a tile seam. The seam fixture is the point: two adjacent tiles assemble
 * the same physical trail from overlapping way sets, and nothing but the ways tells them so.
 */

import { describe, expect, it } from 'vitest';
import { OsmElementType } from '@switchback/db';
import type { Prisma } from '@switchback/db';
import { assembleTrails } from '../src/assemble';
import type { OverpassElement } from '../src/overpass';
import { resolveTrail, trailIdentityMode } from '../src/identity';

/** The real boundary between `120230203` and `120230212`, the two tiles observed splitting. */
const SEAM_LNG = 12.65625;
const LAT = 46.3;

interface Claim {
  wayId: number;
  id: string;
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
                osmType: claim.osmType,
                createdAt: new Date(claim.createdAt),
              },
            })),
        );
      },
    },
  } as unknown as Prisma.TransactionClient;
}

function way(id: number, from: number, to: number): OverpassElement {
  return {
    type: 'way',
    id,
    tags: { name: 'Seam Ridge Trail', highway: 'path' },
    geometry: [
      { lat: LAT, lon: from },
      { lat: LAT, lon: to },
    ],
  };
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

    const fresh = txWith([]);
    expect(await resolveTrail(fresh, west)).toEqual({ kind: 'create' });

    const afterWest = txWith(
      west.memberWayIds.map((wayId) => ({
        wayId,
        id: 'trail-west',
        osmType: OsmElementType.way,
        createdAt: '2026-08-01T00:00:00Z',
      })),
    );
    expect(await resolveTrail(afterWest, east)).toEqual({ kind: 'adopt', trailId: 'trail-west' });
  });
});

describe('resolveTrail', () => {
  const wayTrail = { osmType: 'way' as const, memberWayIds: [1, 2, 3] };

  it('creates when nothing has claimed the ways, or there are none to claim', async () => {
    expect(await resolveTrail(txWith([]), wayTrail)).toEqual({ kind: 'create' });
    expect(await resolveTrail(txWith([]), { osmType: 'way', memberWayIds: [] })).toEqual({
      kind: 'create',
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

  it('yields to a relation rather than merging geometry into it', async () => {
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
          osmType: OsmElementType.relation,
          createdAt: '2026-08-03T00:00:00Z',
        },
      ]),
      wayTrail,
    );
    expect(resolution).toEqual({ kind: 'skip', trailId: 'the-route' });
  });

  it('never routes a relation through claims, so a superroute cannot swallow its members', async () => {
    const claimed = txWith([
      { wayId: 1, id: 'a-member', osmType: OsmElementType.way, createdAt: '2026-08-01T00:00:00Z' },
    ]);
    expect(await resolveTrail(claimed, { osmType: 'relation', memberWayIds: [1, 2, 3] })).toEqual({
      kind: 'create',
    });
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
