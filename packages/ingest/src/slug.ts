/**
 * Trail slugs. `slugLadder` says what a trail may be called, `planTileSlugs` decides which
 * trail gets which before any of them commit, and `uniqueSlug` settles it against the database.
 */

import { Prisma } from '@switchback/db';
import type { OsmElementType } from '@switchback/db';
import { slugify } from './derive';

/** The OSM element a slug is derived from. Ordering by it is what makes a re-ingest converge. */
export interface SlugSubject {
  osmType: 'relation' | 'way';
  osmId: number;
  name: string;
}

/** How the plan indexes a subject. */
export function slugSubjectKey(subject: SlugSubject): string {
  return `${subject.osmType}/${subject.osmId}`;
}

/**
 * The slug nothing else can take. `slugify` collapses every run of non-alphanumerics into one
 * hyphen, so no name-derived slug contains `--`, and `(osmType, osmId)` names one OSM element —
 * two trails can produce this string only by being the same trail.
 */
export function identitySlug(subject: SlugSubject): string {
  return `${slugify(subject.name)}--${subject.osmType}-${BigInt(subject.osmId).toString(36)}`;
}

/**
 * The slugs one trail may hold, best first: the bare name because `/trails/ben-nevis` is what
 * somebody would guess, then region-qualified because that says which Eagle Peak Trail this is,
 * then the identity slug.
 */
export function slugLadder(subject: SlugSubject, regionName: string | null): string[] {
  const ladder = [slugify(subject.name)];
  if (regionName) ladder.push(slugify(subject.name, regionName));
  ladder.push(identitySlug(subject));
  return ladder;
}

/** The ladder a trail should offer, from the plan its tile was given. */
export type SlugPlan = (subject: SlugSubject) => readonly string[];

/** Relations before ways — a relation is the route and a way a fragment of one — then by id. */
function byIdentity(a: SlugSubject, b: SlugSubject): number {
  if (a.osmType !== b.osmType) return a.osmType === 'relation' ? -1 : 1;
  return a.osmId - b.osmId;
}

/**
 * Hand out the contested rungs across a tile's trails before any of them commit.
 *
 * A dense tile assembles a dozen trails under one name — twelve `Chemin d'Exploitation` inside
 * one Ain tile — and the ladder alone does not separate them. Every one of them reads the bare
 * slug as free, because the read and the write are separated by the rest of a 30 s transaction,
 * and Postgres then serialises them at the unique index: the losers block on the winner's
 * uncommitted row, take a `P2002` when it lands, and replay their whole write set. Ranking the
 * group by OSM identity gives each trail a different first candidate, so no two ever ask for the
 * same one and there is nothing left inside the tile to race over.
 *
 * Rank is also what makes the ground converge. Which trail held the bare slug used to be decided
 * by whichever transaction the pool scheduled first, so re-ingesting a wiped tile moved public
 * URLs between OSM ways; ranking is a property of the ways themselves and does not move.
 */
export function planTileSlugs(
  subjects: readonly SlugSubject[],
  regionName: string | null,
): SlugPlan {
  const groups = new Map<string, SlugSubject[]>();
  for (const subject of subjects) {
    const base = slugify(subject.name);
    const group = groups.get(base);
    if (group) group.push(subject);
    else groups.set(base, [subject]);
  }

  const planned = new Map<string, readonly string[]>();
  for (const group of groups.values()) {
    const ranked = [...group].sort(byIdentity);
    for (const [rank, subject] of ranked.entries()) {
      const ladder = slugLadder(subject, regionName);
      planned.set(slugSubjectKey(subject), ladder.slice(Math.min(rank, ladder.length - 1)));
    }
  }

  // Only trails the plan ranked are constrained by it. A route ingested on its own is a batch of
  // one, and anything else gets the top of its own ladder.
  return (subject) => planned.get(slugSubjectKey(subject)) ?? slugLadder(subject, regionName);
}

/**
 * The first candidate free for this trail to take. The last entry is exempt from both reads and
 * returned regardless: nothing else can hold it, and an alias for it can only have been retired
 * from this same OSM element, so handing it back points the permanent link at its own subject.
 */
export async function uniqueSlug(
  tx: Prisma.TransactionClient,
  candidates: readonly string[],
  osmType: OsmElementType,
  osmId: bigint,
): Promise<string> {
  for (const candidate of candidates.slice(0, -1)) {
    const existing = await tx.trail.findUnique({
      where: { slug: candidate },
      select: { osmType: true, osmId: true },
    });
    // Free, or already ours — a re-ingest of the same trail keeps its URL.
    if (existing) {
      if (existing.osmType !== osmType || existing.osmId !== osmId) continue;
      return candidate;
    }
    // A retired slug still answers on `/trails/<slug>`, so handing it to a different trail would
    // point a permanent link at somebody else's trail — worse than the 404 the alias prevents.
    // Read in every mode, not only `claim`: a merge made while the flag was on retires a slug
    // permanently, and the rollback that turns the flag off is exactly when an unrelated trail
    // would otherwise be free to take it.
    //
    // P2021 only, and it is what keeps `osm-id` free of any dependency on this table: a database
    // the DDL has not reached has no aliases, so no candidate is retired and the bare name is
    // free. Vercel Preview builds run branch code against whichever database they are pointed at
    // while `ci.yml`'s `migrate` job runs on `master` alone, so that gap is reachable. Any other
    // error is a real failure and has to keep failing the commit.
    const alias = await tx.trailSlugAlias
      .findUnique({
        where: { slug: candidate },
        select: { slug: true },
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
          return null;
        }
        throw error;
      });
    if (!alias) return candidate;
  }

  const terminal = candidates.at(-1);
  if (terminal === undefined) throw new Error('uniqueSlug needs at least one candidate');
  return terminal;
}
