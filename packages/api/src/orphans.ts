/**
 * The other half of "nothing exists until commit": an upload that succeeds and is never
 * committed leaves bytes in the bucket with nothing pointing at them, which nothing in the
 * product can see and which we pay for forever. The drain cron sweeps them.
 *
 * Two rules make this safe to run unattended, because the failure mode is deleting somebody's
 * photograph. **A grace period far longer than any legitimate gap** — seconds between PUT and
 * commit against a day of grace, so an upload in flight during a sweep cannot be caught. And
 * **the database is asked, never inferred from**: a key is orphaned only if no row holds the URL
 * it maps to. No parsing keys into ids, no "looks unreferenced" heuristic.
 *
 * A cap bounds each run and hitting it is reported rather than swallowed.
 */
import type { PrismaClient } from '@switchback/db';
import { storage } from './storage';

/** Every user photograph lives under this prefix. Nothing else in the bucket is touched. */
const PHOTO_PREFIX = 'photos/';

/**
 * How old an object must be before it is a candidate. Twenty-four hours against a commit window
 * measured in seconds; the margin also covers a sweep and an upload running against clocks that
 * disagree, which on a distributed object store they can by minutes.
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

  // Both renditions are checked independently: `photos.remove` deletes the row first and the
  // objects after, so a half-failed delete leaves exactly one of the two. Treating them as a
  // pair here would mean that one never gets collected.
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
      // One unremovable object must not stop the rest. It is a candidate again next run, and
      // if it is permanent the count of orphans stops falling — which is the signal.
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
