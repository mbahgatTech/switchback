/**
 * Admission control for the ingest queue.
 *
 * Everything else in this package bounds a *single* call — the twelve-tile viewport
 * ceiling, the ninety-six-tile area cap, the freshness check that makes a repeat press
 * free, the job dedupe that collapses concurrent presses onto one row. None of them bounds
 * a stranger with a script, because every one of them resets on the next bounding box.
 *
 * This module is the part that is about strangers. It answers one question — *may anything
 * new be queued right now* — and the two enqueue functions ask it before they write.
 *
 * **Why here and not at the call sites.** The guard used to live at exactly one call site,
 * inside `requestArea`, which is the one path a person reaches by pressing a button. The
 * two paths that queue without anybody pressing anything — `ensureCoverage` behind
 * `trails.browse`/`coverage`/`search`, and `ensureNetworkCoverage` behind
 * `routes.coverage`/`plan` — queued unconditionally, so the guarded door was the only door
 * that was locked. `queueTiles` and `queueNetworkTiles` are the choke point every writing
 * path crosses, and putting the check in them closes all of it at once. It also survives
 * request batching: each batched call runs the check and sees what the calls before it in
 * the same request have already queued.
 *
 * Two limits, because they fail differently:
 *
 * - **Queue depth** is about *time*. A deep queue is not dangerous, it is slow, and the
 *   damage is that every live viewport sits behind hours of ground nobody is looking at.
 * - **Database size** is about *space*, and that one is terminal. Six hundred jobs times
 *   `MAX_TILE_BYTES` is 7.2 GB of fetched OSM against a half-gigabyte Postgres, nothing
 *   reclaims a row, and a full database does not degrade — it stops accepting writes, which
 *   takes sign-in and activity recording down with the map.
 *
 * The failure mode both produce is the same and is chosen deliberately: **the map stops
 * filling, and says so.** Reads keep working, everything already ingested still draws, and
 * the reader gets a sentence explaining why nothing new is arriving. That is a bad
 * afternoon. A database at 100% is a bad week.
 */

import { JobKind, JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';

/**
 * Refuse to queue new ingest past this many jobs already waiting.
 *
 * Six hundred is roughly six area presses' worth, or an hour of drain at the rate the
 * Overpass client's concurrency limit allows. Past it, a new tile would not be fetched any
 * sooner for being queued, so queueing it buys nothing and costs a row.
 *
 * Note what is counted: all three ingest kinds, not just `ingest_tile`. The original guard
 * counted `ingest_tile` alone while the routing queue enqueued `ingest_network`, so the
 * routing queue was invisible to the only thing watching — a second, unbounded queue
 * sharing the same database and the same Overpass budget.
 */
export const MAX_TILE_QUEUE_DEPTH = 600;

/** The kinds that fetch new ground, and so the kinds that can fill a database. */
export const INGEST_JOB_KINDS = [
  JobKind.ingest_tile,
  JobKind.refresh_tile,
  JobKind.ingest_network,
] as const;

/**
 * How full the database may get before new ingest is refused.
 *
 * Not 100%, because the point is to stop *before* the writes that matter start failing. The
 * fifteen percent left over is what sign-ins, activity uploads, reviews and the drain's own
 * bookkeeping run on while an operator decides what to delete.
 */
export const MAX_STORAGE_FRACTION = 0.85;

/**
 * The database's size ceiling in bytes. `DATABASE_SIZE_LIMIT_BYTES` overrides it.
 *
 * A plan property rather than something Postgres will tell us — `pg_database_size` reports
 * what is used, and nothing reports what is allowed — so it has to be written down. The
 * default is the half gigabyte the free tier gives.
 */
export const DEFAULT_DATABASE_LIMIT_BYTES = 512 * 1024 * 1024;

/** How long a database-size reading is trusted. */
export const STORAGE_CACHE_MS = 60_000;

/** Why ingest was refused, or `null` when it was not. */
export type IngestRefusal = 'queue-depth' | 'storage';

interface StorageReading {
  bytes: number;
  limit: number;
  readAt: number;
}

let cached: StorageReading | null = null;

/** Test seam: forget the cached database size so the next check re-reads it. */
export function resetStorageCache(): void {
  cached = null;
}

function databaseLimitBytes(): number {
  const configured = Number(process.env.DATABASE_SIZE_LIMIT_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DATABASE_LIMIT_BYTES;
}

/**
 * How much of the database is used, cached for a minute.
 *
 * Cached because this sits in front of `trails.browse`, which every pan and zoom fires:
 * uncached, it would add a round trip to every map movement in the product to answer a
 * question whose answer moves by kilobytes a minute. Sixty seconds is far quicker than the
 * database can plausibly fill and cheap enough to be invisible.
 *
 * Returns `null` when it cannot tell, and the caller treats that as permission. A size probe
 * that fails is a broken instrument, not a full disk, and an instrument failure must not be
 * able to stop the map filling — the depth guard above is the one that has to hold.
 */
async function storageFraction(db: PrismaClient, now: number): Promise<number | null> {
  if (cached && now - cached.readAt < STORAGE_CACHE_MS) return cached.bytes / cached.limit;

  try {
    const rows = await db.$queryRaw<Array<{ bytes: bigint }>>`
      SELECT pg_database_size(current_database()) AS bytes
    `;
    const raw = rows[0]?.bytes;
    if (raw === undefined) return null;

    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;

    cached = { bytes, limit: databaseLimitBytes(), readAt: now };
    return cached.bytes / cached.limit;
  } catch {
    // Deliberately quiet. This runs behind every viewport, and a database refusing the probe
    // is a database already logging the underlying failure from somewhere far more useful.
    // A stand-in client without `$queryRaw` lands here too, which is the behaviour we want:
    // no reading, no opinion.
    return null;
  }
}

/**
 * May new ingest be queued? `null` means yes.
 *
 * Depth first, because it is one indexed count against a table we are about to write to
 * anyway, and it is the limit that trips in ordinary abuse. The size read only happens on
 * the calls that get past it, and at most once a minute.
 */
export async function admitIngest(
  db: PrismaClient,
  now: number = Date.now(),
): Promise<IngestRefusal | null> {
  const depth = await db.ingestJob.count({
    where: {
      kind: { in: [...INGEST_JOB_KINDS] },
      status: { in: [JobStatus.queued, JobStatus.running] },
    },
  });
  if (depth >= MAX_TILE_QUEUE_DEPTH) {
    // The line an operator greps for. Both refusals name the number they tripped, because
    // "ingest refused" without one tells you the guard fired and nothing about whether it
    // fired correctly.
    console.warn(
      `ingest refused: queue depth ${depth} at or past the ${MAX_TILE_QUEUE_DEPTH} ceiling`,
    );
    return 'queue-depth';
  }

  const fraction = await storageFraction(db, now);
  if (fraction !== null && fraction >= MAX_STORAGE_FRACTION) {
    console.warn(
      `ingest refused: database ${(fraction * 100).toFixed(1)}% full, ceiling ${(MAX_STORAGE_FRACTION * 100).toFixed(0)}%`,
    );
    return 'storage';
  }

  return null;
}
