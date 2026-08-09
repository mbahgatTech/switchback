import type { Prisma } from '@prisma/client';
import { OsmElementType, Prisma as PrismaNamespace } from '@prisma/client';
import type { ElevationPoint, LineString, LngLat } from '@switchback/core';
import { writeTrailGeometries, writeWaypointPointsFor } from '@switchback/db';
import type { AssembledTrail } from './assemble';
import { ClaimConflictError } from './identity';
import type { ClaimPolicy } from './identity';

/**
 * Committing a tile's trails in batches rather than one transaction each. `pipeline.ts` owns
 * what a trail *is*; this owns how a group of finished trails reaches the database.
 */

/**
 * Trails per write transaction.
 *
 * Sized against the two costs it trades off, measured on tile `023010230` against a local
 * PostGIS: the per-trail statements that stay per-trail (the row upsert and the way claim) set
 * the floor, and the batch-wide statements amortise over the size. Going from 1 to 25 removed
 * 83% of the commit phase's round trips; 25 to 50 removed a further 3%, for twice the work a
 * poison row costs and twice the geometry held in memory against the Consumption instance's
 * 1.5 GB. The knee is well below 50, so this sits at the low end of the flat part.
 */
export const COMMIT_BATCH_SIZE = 25;

/** One trail, computed and ready to write. Everything expensive has already happened. */
export interface PreparedTrail {
  trail: AssembledTrail;
  /** Null until the row is created; set for adopt and merge. */
  trailId: string | null;
  retiredIds: string[];
  claim: ClaimPolicy;
  conceded: readonly number[];
  osmType: OsmElementType;
  osmId: bigint;
  row: Prisma.TrailUncheckedCreateInput;
  geometry: LineString;
  centroid: LngLat;
  profile: ElevationPoint[];
  spacingM: number;
  highPointIndex: number;
  waypoints: Prisma.WaypointCreateManyInput[];
}

/**
 * Split a tile's trails into groups no two of which claim the same OSM way.
 *
 * The disjointness is not tidiness — it is what lets `writeCommitBatch` read every claim in the
 * batch once. Two trails sharing a way have to see each other's insert to arbitrate, and a
 * single batch-wide read cannot show that; putting them in successive batches restores the
 * ordering, and the second one resolves against the first's committed row. Tile `021231030`
 * has three such ways among 144 trails, so this is reachable, not theoretical.
 */
export function planCommitBatches(
  trails: readonly AssembledTrail[],
  maxSize = COMMIT_BATCH_SIZE,
): AssembledTrail[][] {
  const batches: AssembledTrail[][] = [];
  let current: AssembledTrail[] = [];
  let claimed = new Set<number>();

  for (const trail of trails) {
    const collides = trail.memberWayIds.some((wayId) => claimed.has(wayId));
    if (current.length > 0 && (collides || current.length >= maxSize)) {
      batches.push(current);
      current = [];
      claimed = new Set<number>();
    }
    current.push(trail);
    for (const wayId of trail.memberWayIds) claimed.add(wayId);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Prisma's code for a table the migrations have not reached. */
const MISSING_TABLE = 'P2021';

interface SlugHolder {
  osmType: OsmElementType | null;
  osmId: bigint | null;
}

/** One trail's claim on a name: the ladder it will accept, and who it is. */
export interface SlugWant {
  osmType: OsmElementType;
  osmId: bigint;
  /** Best first. The last rung must be unique by construction — see `slugLadder`. */
  candidates: readonly string[];
}

/**
 * A slug for every trail in the batch, decided against one pair of reads instead of a ladder
 * walk each. Returned in the order given.
 *
 * `taken` is the part a per-trail walk never needed: two trails in one transaction both see a
 * name free, and without it both would take it and the batch would die on the unique index.
 *
 * A slug a merge retired still answers on `/trails/<slug>`, so handing it to a different trail
 * would point a permanent link at somebody else's trail. That is read in every identity mode,
 * not only `claim`: a merge made while the flag was on retires a slug permanently, and the
 * rollback that turns the flag off is exactly when an unrelated trail would be free to take it.
 * `P2021` alone is tolerated, and it is what keeps `osm-id` free of any dependency on the table
 * — a database the DDL has not reached has no aliases, so no candidate is retired. Any other
 * error is a real failure and has to keep failing the commit.
 */
export async function assignSlugs(
  tx: Prisma.TransactionClient,
  wants: readonly SlugWant[],
): Promise<string[]> {
  const every = [...new Set(wants.flatMap((want) => [...want.candidates]))];
  if (every.length === 0) return [];

  const held = new Map<string, SlugHolder>();
  for (const row of await tx.trail.findMany({
    where: { slug: { in: every } },
    select: { slug: true, osmType: true, osmId: true },
  })) {
    held.set(row.slug, { osmType: row.osmType, osmId: row.osmId });
  }

  const aliases = await tx.trailSlugAlias
    .findMany({ where: { slug: { in: every } }, select: { slug: true } })
    .catch((error: unknown) => {
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === MISSING_TABLE
      ) {
        return [];
      }
      throw error;
    });
  const retired = new Set(aliases.map((row) => row.slug));

  const taken = new Set<string>();
  return wants.map((want) => {
    let slug = want.candidates[want.candidates.length - 1]!;
    for (const candidate of want.candidates) {
      if (taken.has(candidate)) continue;
      const owner = held.get(candidate);
      if (owner) {
        // Free, or already ours — a re-ingest of the same trail keeps its URL.
        if (owner.osmType === want.osmType && owner.osmId === want.osmId) {
          slug = candidate;
          break;
        }
        continue;
      }
      if (retired.has(candidate)) continue;
      slug = candidate;
      break;
    }
    taken.add(slug);
    return slug;
  });
}

/**
 * Point every batch member's ways at it, from one read of the claims.
 *
 * The read is batch-wide because `planCommitBatches` guarantees no two members want the same
 * way; the *insert* stays per trail because it is the serialisation point, and a unique
 * violation on a combined insert would name a batch rather than the trail that lost the race.
 */
async function claimBatchWays(
  tx: Prisma.TransactionClient,
  entries: ReadonlyArray<{ prepared: PreparedTrail; trailId: string }>,
): Promise<void> {
  const wanted = [
    ...new Set(entries.flatMap(({ prepared }) => prepared.trail.memberWayIds)),
  ].map((id) => BigInt(id));
  if (wanted.length === 0) return;

  const held = new Map<bigint, string>();
  for (const row of await tx.trailWay.findMany({
    where: { wayId: { in: wanted } },
    select: { wayId: true, trailId: true },
  })) {
    held.set(row.wayId, row.trailId);
  }

  for (const { prepared, trailId } of entries) {
    const ids = [...new Set(prepared.trail.memberWayIds)].map((id) => BigInt(id));
    if (ids.length === 0) continue;
    const allowed = new Set(prepared.conceded.map((id) => BigInt(id)));
    const contested = ids.filter((wayId) => held.has(wayId) && held.get(wayId) !== trailId);

    if (prepared.claim === 'take') {
      if (contested.length > 0) {
        await tx.trailWay.updateMany({ where: { wayId: { in: contested } }, data: { trailId } });
      }
    } else {
      const raced = contested.find((wayId) => !allowed.has(wayId));
      if (raced !== undefined) throw new ClaimConflictError(raced);
    }

    const fresh = ids.filter((wayId) => !held.has(wayId));
    if (fresh.length === 0) continue;
    try {
      await tx.trailWay.createMany({ data: fresh.map((wayId) => ({ wayId, trailId })) });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'P2002') {
        throw new ClaimConflictError(fresh[0]!);
      }
      throw error;
    }
    for (const wayId of fresh) held.set(wayId, trailId);
  }
}

export interface BatchWriteContext {
  identity: 'claim' | 'osm-id';
  /** `uniqueSlug`'s ladder for one trail, injected so the rungs are defined in one place. */
  slugCandidates: (prepared: PreparedTrail) => string[];
  mergeTrails: (tx: Prisma.TransactionClient, winnerId: string, loserIds: string[]) => Promise<void>;
}

/**
 * Write a batch of prepared trails in one transaction: their rows, their claims, and their
 * geometry, profiles and waypoints. Returns each trail's id in the order given.
 *
 * The transaction spans the whole batch for the reason it used to span one trail — a trail row
 * whose `geom` write failed is invisible to every spatial query while still appearing in
 * search. Nothing here computes; every expensive step ran before the transaction opened, so it
 * holds a connection only for round trips.
 */
export async function writeCommitBatch(
  tx: Prisma.TransactionClient,
  prepared: readonly PreparedTrail[],
  ctx: BatchWriteContext,
): Promise<string[]> {
  if (prepared.length === 0) return [];

  for (const entry of prepared) {
    if (entry.trailId && entry.retiredIds.length > 0) {
      await ctx.mergeTrails(tx, entry.trailId, entry.retiredIds);
    }
  }

  const slugs = await assignSlugs(
    tx,
    prepared.map((entry) => ({
      osmType: entry.osmType,
      osmId: entry.osmId,
      candidates: ctx.slugCandidates(entry),
    })),
  );
  const written: Array<{ prepared: PreparedTrail; trailId: string }> = [];

  for (const [index, entry] of prepared.entries()) {
    const row = { ...entry.row, slug: slugs[index]! };
    // `osmType`/`osmId`/`quadkey`/`slug` are never rewritten on an existing row — see the
    // reasons on `Trail` in `pipeline.ts`.
    const saved = entry.trailId
      ? await tx.trail.update({
          where: { id: entry.trailId },
          data: { ...row, slug: undefined, osmType: undefined, osmId: undefined, quadkey: undefined },
        })
      : await tx.trail.upsert({
          where: { osmType_osmId: { osmType: entry.osmType, osmId: entry.osmId } },
          create: row,
          update: { ...row, slug: undefined },
        });
    written.push({ prepared: entry, trailId: saved.id });
  }

  if (ctx.identity === 'claim') await claimBatchWays(tx, written);

  await writeTrailGeometries(
    tx,
    written.map(({ prepared: entry, trailId }) => ({
      trailId,
      geometry: entry.geometry,
      centroid: entry.centroid,
    })),
  );

  const trailIds = written.map(({ trailId }) => trailId);

  // Replaced rather than upserted, so one statement covers the batch. `elevation_profiles`
  // has no id of its own and nothing reads its `createdAt`, so the row is interchangeable.
  await tx.elevationProfile.deleteMany({ where: { trailId: { in: trailIds } } });
  await tx.elevationProfile.createMany({
    data: written.map(({ prepared: entry, trailId }) => ({
      trailId,
      points: entry.profile as unknown as Prisma.InputJsonValue,
      spacingM: entry.spacingM,
      highPointIndex: entry.highPointIndex,
    })),
  });

  await tx.waypoint.deleteMany({ where: { trailId: { in: trailIds } } });
  const waypoints = written.flatMap(({ prepared: entry, trailId }) =>
    entry.waypoints.map((waypoint) => ({ ...waypoint, trailId })),
  );
  if (waypoints.length > 0) {
    await tx.waypoint.createMany({ data: waypoints });
    await writeWaypointPointsFor(tx, trailIds);
  }

  return trailIds;
}
