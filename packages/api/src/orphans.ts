/**
 * The other half of "nothing exists until commit".
 *
 * `photos.presign` hands out a ticket, the browser `PUT`s straight to the bucket, and only
 * the subsequent `commit` writes a row. That ordering is what keeps every read query free of
 * half-finished uploads — see the header of `routers/photos.ts` — but it has a cost, and this
 * file is the cost: an upload that succeeds and is never committed leaves bytes in the bucket
 * with nothing pointing at them. A closed laptop lid between the PUT and the commit is enough.
 *
 * Nothing in the product can see those bytes. We would simply pay for them, forever, at a
 * rate set by how often people abandon an upload. So the drain cron sweeps them.
 *
 * **Two rules make this safe to run unattended**, because the failure mode of a sweeper that
 * gets it wrong is deleting a photograph somebody took:
 *
 * 1. **A grace period far longer than any legitimate gap.** The window between a PUT landing
 *    and its row being written is seconds; the grace is a day. An object younger than that is
 *    not even looked at, so an upload in flight during a sweep cannot be caught by it.
 * 2. **The database is asked, never inferred from.** A key is orphaned only if no row holds
 *    the URL it maps to. There is no parsing of keys into ids, no assumption about which user
 *    a prefix belongs to, and no "looks unreferenced" heuristic.
 *
 * A cap bounds each run, and hitting it is reported rather than swallowed: a sweep that
 * silently examined the first two thousand of a million objects and announced success would
 * be worse than no sweep at all.
 */
import type { PrismaClient } from '@switchback/db';
import { storage } from './storage';

/** Every user photograph lives under this prefix. Nothing else in the bucket is touched. */
const PHOTO_PREFIX = 'photos/';

/**
 * How old an object must be before it is a candidate.
 *
 * Twenty-four hours against a commit window measured in seconds. The margin is not caution
 * for its own sake — it also covers the case where the sweep and an upload run against
 * clocks that disagree, which on a distributed object store they can by minutes.
 */
const GRACE_MS = 24 * 60 * 60 * 1000;

/** Objects examined per run. See the note about caps above. */
const SCAN_LIMIT = 2_000;

/** Objects deleted per run, so a bug cannot empty a bucket faster than it is noticed. */
const DELETE_LIMIT = 200;

/** Keys per `IN (…)`. Postgres copes with far more; this keeps the query plan sane. */
const LOOKUP_CHUNK = 250;

export interface SweepResult {
  /** Objects old enough to be candidates. */
  scanned: number;
  /** Of those, how many no row referenced. */
  orphaned: number;
  /** Of those, how many were actually removed this run. */
  deleted: number;
  /** True when the scan or the delete cap was reached and there is more to do next tick. */
  truncated: boolean;
}

export async function sweepOrphanedPhotos(
  db: PrismaClient,
  options: { now?: Date } = {},
): Promise<SweepResult> {
  const driver = storage();
  const cutoff = (options.now?.getTime() ?? Date.now()) - GRACE_MS;

  const listed = await driver.list(PHOTO_PREFIX, SCAN_LIMIT);
  const candidates = listed.filter((entry) => entry.lastModified.getTime() < cutoff);

  /*
   * Both renditions of a photograph are checked independently, and that is deliberate. A
   * commit writes `url` and `thumbUrl` together, so in practice they are referenced or
   * orphaned as a pair — but `photos.remove` deletes the row first and the objects after,
   * and if the second delete half-fails we are left with exactly one of the two. Treating
   * them as a pair here would mean that one never gets collected.
   */
  const referenced = new Set<string>();
  const urls = candidates.map((entry) => driver.publicUrl(entry.key));
  for (let i = 0; i < urls.length; i += LOOKUP_CHUNK) {
    const chunk = urls.slice(i, i + LOOKUP_CHUNK);
    const rows = await db.photo.findMany({
      where: { OR: [{ url: { in: chunk } }, { thumbUrl: { in: chunk } }] },
      select: { url: true, thumbUrl: true },
    });
    for (const row of rows) {
      referenced.add(row.url);
      if (row.thumbUrl) referenced.add(row.thumbUrl);
    }
  }

  const orphans = candidates.filter((entry, index) => !referenced.has(urls[index] ?? ''));

  let deleted = 0;
  for (const orphan of orphans.slice(0, DELETE_LIMIT)) {
    try {
      await driver.remove(orphan.key);
      deleted += 1;
    } catch (error) {
      // One unremovable object must not stop the rest. It will be a candidate again next run,
      // and if it is permanent the count of orphans stops falling — which is the signal.
      console.warn(`orphan sweep: could not remove ${orphan.key}`, error);
    }
  }

  return {
    scanned: candidates.length,
    orphaned: orphans.length,
    deleted,
    truncated: listed.length >= SCAN_LIMIT || orphans.length > DELETE_LIMIT,
  };
}
