import type { Prisma } from '@prisma/client';
import { OsmElementType } from '@prisma/client';
import { normalizeName } from './assemble';

/**
 * Trail identity that survives a tile seam. A way-derived trail is identified by the OSM ways it
 * is made of, not by `min(wayId)` over whichever subset one tile happened to return.
 */

/** `claim` resolves through `TrailWay`; `osm-id` keeps the `(osmType, osmId)` upsert. */
export type TrailIdentityMode = 'claim' | 'osm-id';

/**
 * `INGEST_TRAIL_IDENTITY`, defaulting to the pre-claim behaviour. Only *resolution* is gated —
 * claims are written under both settings, so flipping back leaves a populated table unused and
 * flipping forward needs no backfill.
 */
export function trailIdentityMode(source: NodeJS.ProcessEnv = process.env): TrailIdentityMode {
  return source.INGEST_TRAIL_IDENTITY === 'claim' ? 'claim' : 'osm-id';
}

/**
 * What `claimWays` does about a way some other trail already holds.
 *
 * `fail` is the concurrency control. The resolution that produced it said nobody else owns these
 * ways, so a row appearing underneath it is a committer racing this one, and the only safe answer
 * is to unwind and resolve again — overwriting would leave two trail rows for one trail, which is
 * the corruption `TrailWay` exists to prevent. `yield` is for the cases where another trail owns
 * a way legitimately, and `take` for a relation, whose id is authoritative in every tile.
 */
export type ClaimPolicy = 'take' | 'yield' | 'fail';

/**
 * What to do with an assembled trail. `create` means fall through to the `(osmType, osmId)`
 * upsert — the path taken when nothing has claimed these ways, and always for relations.
 */
export type Resolution =
  | { kind: 'create'; claim: ClaimPolicy }
  | { kind: 'adopt'; trailId: string; claim: ClaimPolicy }
  | { kind: 'merge'; trailId: string; retiredIds: string[]; claim: ClaimPolicy }
  | { kind: 'skip'; trailId: string };

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/** A way this commit expected to own turned out to belong to another trail. */
export class ClaimConflictError extends Error {
  constructor(readonly wayId: bigint) {
    super(`way ${wayId} is claimed by another trail`);
    this.name = 'ClaimConflictError';
  }
}

export interface ClaimInput {
  osmType: 'relation' | 'way';
  name: string;
  memberWayIds: readonly number[];
}

type Claimant = { id: string; name: string; osmType: OsmElementType | null; createdAt: Date };

/** Oldest first, id breaking ties, so every tile picks the same winner from the same set. */
function byAge(a: Claimant, b: Claimant): number {
  const delta = a.createdAt.getTime() - b.createdAt.getTime();
  return delta !== 0 ? delta : a.id < b.id ? -1 : 1;
}

/**
 * Which trail an assembly belongs to, from the ways it is made of.
 *
 * Relations never resolve through claims: a relation id is the same in every tile, so
 * `(osmType, osmId)` already identifies them, and routing them through a merge would let a
 * superroute swallow the trails beneath it.
 */
export async function resolveTrail(
  tx: Prisma.TransactionClient,
  input: ClaimInput,
): Promise<Resolution> {
  if (input.osmType === 'relation') return { kind: 'create', claim: 'take' };
  if (input.memberWayIds.length === 0) return { kind: 'create', claim: 'fail' };

  const claims = await tx.trailWay.findMany({
    where: { wayId: { in: input.memberWayIds.map((id) => BigInt(id)) } },
    select: { trail: { select: { id: true, name: true, osmType: true, createdAt: true } } },
  });
  if (claims.length === 0) return { kind: 'create', claim: 'fail' };

  const distinct = new Map<string, Claimant>();
  for (const claim of claims) distinct.set(claim.trail.id, claim.trail);
  const claimants = [...distinct.values()].sort(byAge);

  /*
   * Both halves of the rule `assembleTrails` applies inside one tile, carried across the seam
   * where the tile holding the relation and the tile holding the way are different queries. A way
   * a relation claims *and* names the same is a fragment of it. A way it claims but names
   * differently — the Mist Trail inside the John Muir Trail — is a trail in its own right, and
   * skipping it would delete it from the corpus with no trace.
   */
  const wanted = normalizeName(input.name);
  const relation = claimants.find(
    (c) => c.osmType === OsmElementType.relation && normalizeName(c.name) === wanted,
  );
  if (relation) return { kind: 'skip', trailId: relation.id };

  const ways = claimants.filter((c) => c.osmType !== OsmElementType.relation);
  // Every claimant is a relation under some other name. Those ways are the relation's; this trail
  // keeps its own row and leaves them alone rather than fighting for them on every ingest.
  if (ways.length === 0) return { kind: 'create', claim: 'yield' };

  const [winner, ...rest] = ways as [Claimant, ...Claimant[]];
  return rest.length === 0
    ? { kind: 'adopt', trailId: winner.id, claim: 'fail' }
    : { kind: 'merge', trailId: winner.id, retiredIds: rest.map((c) => c.id), claim: 'fail' };
}

/**
 * Point ways at this trail, in two round trips rather than one upsert each — a long relation's
 * member list runs to hundreds of ways inside a transaction with a 30 s ceiling.
 */
export async function claimWays(
  tx: Prisma.TransactionClient,
  trailId: string,
  wayIds: readonly number[],
  policy: ClaimPolicy,
): Promise<void> {
  if (wayIds.length === 0) return;
  const ids = [...new Set(wayIds)].map((id) => BigInt(id));

  const held = await tx.trailWay.findMany({
    where: { wayId: { in: ids } },
    select: { wayId: true, trailId: true },
  });
  const contested = held.filter((row) => row.trailId !== trailId);

  if (contested.length > 0) {
    if (policy === 'fail') throw new ClaimConflictError(contested[0]!.wayId);
    if (policy === 'take') {
      await tx.trailWay.updateMany({
        where: { wayId: { in: contested.map((row) => row.wayId) } },
        data: { trailId },
      });
    }
  }

  const seen = new Set(held.map((row) => row.wayId));
  const fresh = ids.filter((wayId) => !seen.has(wayId));
  if (fresh.length === 0) return;

  try {
    await tx.trailWay.createMany({
      data: fresh.map((wayId) => ({ wayId, trailId })),
      skipDuplicates: policy === 'yield',
    });
  } catch (error) {
    // The primary key is the serialisation point: `held` was read in this transaction, so a row
    // that was not there and is there now belongs to a committer that got in first.
    if ((error as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
      throw new ClaimConflictError(fresh[0]!);
    }
    throw error;
  }
}

/**
 * Whether the losing halves can be folded into the winner without destroying anything a reader
 * wrote. `Review` is unique per `(trail, user)`, so one person who reported both halves of a
 * fragmented trail has two rows that cannot both survive the re-point — and a tidier corpus is
 * never worth somebody's trail report. Read-only, so the caller can ask before it commits.
 */
export async function canMergeTrails(
  db: Prisma.TransactionClient,
  winnerId: string,
  loserIds: readonly string[],
): Promise<boolean> {
  if (loserIds.length === 0) return true;
  const held = await db.review.findMany({ where: { trailId: winnerId }, select: { userId: true } });
  if (held.length === 0) return true;
  const clash = await db.review.findFirst({
    where: { trailId: { in: [...loserIds] }, userId: { in: held.map((r) => r.userId) } },
    select: { id: true },
  });
  return clash === null;
}

/**
 * Fold the losing halves of a fragmented trail into the winner. Nothing a reader wrote is
 * deleted: `canMergeTrails` has already refused any merge that would have to drop a review, and
 * every other row either moves or is a duplicate of one the winner already holds.
 */
export async function mergeTrails(
  tx: Prisma.TransactionClient,
  winnerId: string,
  loserIds: readonly string[],
): Promise<void> {
  if (loserIds.length === 0) return;
  const from = { in: [...loserIds] };

  // `Trail.primaryPhotoId` is @unique, so a hero still pointed at by a loser blocks the photo
  // that carries it from being re-parented onto the winner.
  await tx.trail.updateMany({ where: { id: from }, data: { primaryPhotoId: null } });

  await tx.trailSlugAlias.createMany({
    data: (await tx.trail.findMany({ where: { id: from }, select: { slug: true } })).map((row) => ({
      slug: row.slug,
      trailId: winnerId,
    })),
    skipDuplicates: true,
  });
  await tx.trailSlugAlias.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });

  await tx.review.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });
  await dedupeThenRepoint(tx, winnerId, loserIds);

  await tx.activity.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });
  await tx.lifelineSession.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });
  await tx.completion.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });
  await tx.trailWay.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });

  await refreshAggregates(tx, winnerId, loserIds);
  await tx.trail.deleteMany({ where: { id: from } });
}

/**
 * The two relations whose uniqueness spans `trailId` and whose conflicting rows are duplicates
 * rather than content: a `(source, sourceId)` photo is the same upstream photograph attached to
 * both halves — user uploads key on their own storage id and never collide — and a list holding
 * both halves must not hold the merged trail twice. Busyness is a derived prior recomputed from
 * activity, so the losers' buckets are dropped rather than reconciled hour by hour.
 */
async function dedupeThenRepoint(
  tx: Prisma.TransactionClient,
  winnerId: string,
  loserIds: readonly string[],
): Promise<void> {
  const from = { in: [...loserIds] };

  const heldPhotos = await tx.photo.findMany({
    where: { trailId: winnerId },
    select: { source: true, sourceId: true },
  });
  for (const photo of heldPhotos) {
    await tx.photo.deleteMany({
      where: { trailId: from, source: photo.source, sourceId: photo.sourceId },
    });
  }
  await tx.photo.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });

  const heldLists = await tx.trailListItem.findMany({
    where: { trailId: winnerId },
    select: { listId: true },
  });
  await tx.trailListItem.deleteMany({
    where: { trailId: from, listId: { in: heldLists.map((l) => l.listId) } },
  });
  await tx.trailListItem.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });

  await tx.busynessBucket.deleteMany({ where: { trailId: from } });
}

/**
 * Settle the winner's denormalised counters over the rows the merge just moved onto it. The two
 * counts are recomputed from what exists, the way the review and photo routers do it; popularity
 * is a running total nothing recomputes, so the losers' are added instead.
 */
async function refreshAggregates(
  tx: Prisma.TransactionClient,
  winnerId: string,
  loserIds: readonly string[],
): Promise<void> {
  const visible = { trailId: winnerId, hiddenAt: null };
  const [ratings, photoCount, losers] = await Promise.all([
    tx.review.aggregate({ where: visible, _avg: { rating: true }, _count: { _all: true } }),
    tx.photo.count({ where: visible }),
    tx.trail.findMany({ where: { id: { in: [...loserIds] } }, select: { popularity: true } }),
  ]);

  await tx.trail.update({
    where: { id: winnerId },
    data: {
      rating: ratings._avg.rating,
      reviewCount: ratings._count._all,
      photoCount,
      popularity: { increment: losers.reduce((sum, row) => sum + row.popularity, 0) },
    },
  });
}
