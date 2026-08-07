import type { Prisma } from '@prisma/client';
import { OsmElementType } from '@prisma/client';

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

export interface ClaimInput {
  osmType: 'relation' | 'way';
  memberWayIds: readonly number[];
}

/**
 * What to do with an assembled trail. `create` means fall through to the `(osmType, osmId)`
 * upsert — the path taken when nothing has claimed these ways, and always for relations.
 */
export type Resolution =
  | { kind: 'create' }
  | { kind: 'adopt'; trailId: string }
  | { kind: 'merge'; trailId: string; retiredIds: string[] }
  | { kind: 'skip'; trailId: string };

type Claimant = { id: string; osmType: OsmElementType | null; createdAt: Date };

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
  if (input.osmType === 'relation' || input.memberWayIds.length === 0) return { kind: 'create' };

  const claims = await tx.trailWay.findMany({
    where: { wayId: { in: input.memberWayIds.map((id) => BigInt(id)) } },
    select: { trail: { select: { id: true, osmType: true, createdAt: true } } },
  });
  if (claims.length === 0) return { kind: 'create' };

  const distinct = new Map<string, Claimant>();
  for (const claim of claims) distinct.set(claim.trail.id, claim.trail);
  const claimants = [...distinct.values()].sort(byAge);

  // Extends the rule `assembleTrails` already applies inside one tile — a named way carrying its
  // relation's name is a fragment of it, not a second trail — across the seam, where the tile
  // that holds the relation and the tile that holds the way are different queries.
  const relation = claimants.find((c) => c.osmType === OsmElementType.relation);
  if (relation) return { kind: 'skip', trailId: relation.id };

  const [winner, ...rest] = claimants as [Claimant, ...Claimant[]];
  return rest.length === 0
    ? { kind: 'adopt', trailId: winner.id }
    : { kind: 'merge', trailId: winner.id, retiredIds: rest.map((c) => c.id) };
}

/** Point every way at this trail. Last writer wins, which is how a relation takes ways back. */
export async function claimWays(
  tx: Prisma.TransactionClient,
  trailId: string,
  wayIds: readonly number[],
): Promise<void> {
  for (const id of wayIds) {
    const wayId = BigInt(id);
    await tx.trailWay.upsert({
      where: { wayId },
      create: { wayId, trailId },
      update: { trailId },
    });
  }
}

/**
 * Fold the losing halves of a fragmented trail into the winner: everything a reader created
 * moves across, the retired slugs keep resolving, and the loser rows go.
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

  await repointUnique(tx, winnerId, loserIds);

  await tx.activity.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });
  await tx.lifelineSession.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });
  await tx.completion.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });
  await tx.trailWay.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });

  await tx.trail.deleteMany({ where: { id: from } });
}

/**
 * The four relations carrying a uniqueness constraint that spans `trailId`. A loser row whose
 * key the winner already holds is dropped rather than re-pointed — re-pointing it would abort
 * the whole trail on P2002, and the winner's row is the one the reader already sees.
 */
async function repointUnique(
  tx: Prisma.TransactionClient,
  winnerId: string,
  loserIds: readonly string[],
): Promise<void> {
  const from = { in: [...loserIds] };

  const reviewers = await tx.review.findMany({
    where: { trailId: winnerId },
    select: { userId: true },
  });
  await tx.review.deleteMany({
    where: { trailId: from, userId: { in: reviewers.map((r) => r.userId) } },
  });
  await tx.review.updateMany({ where: { trailId: from }, data: { trailId: winnerId } });

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

  // Buckets are a derived prior, recomputed from activity, so the losers' are dropped whole
  // rather than reconciled hour by hour against the winner's composite primary key.
  await tx.busynessBucket.deleteMany({ where: { trailId: from } });
}
