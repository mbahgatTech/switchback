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
 * path crosses, and putting the check in them closes all of it at once.
 *
 * **What it does not do: survive request batching.** An earlier version of this comment
 * claimed each batched call sees what the calls before it in the same request queued. It
 * does not, and the claim was the most dangerous line in the file, because it told the next
 * reader the easiest bypass was already handled. tRPC starts every call in a batch at
 * once — `resolveResponse` builds `info.calls.map(async (call) => …)` and then awaits
 * `Promise.all` — so N batched calls all reach `admitIngest` before any of them has written
 * a row, all read the same pre-write depth, and all pass. `admitIngest` is a bare count
 * followed by unlocked upserts: no transaction, no advisory lock, no compare-and-set. The
 * real bound on one request is therefore `MAX_TILE_QUEUE_DEPTH` plus batch size times the
 * per-call tile cap — with the batch capped at 16 and `trails.fetchArea` (a
 * `publicProcedure`) queueing up to `MAX_AREA_TILES` = 96, one hand-rolled POST can
 * overshoot to about 1,536 tiles, and M parallel requests multiply that. Nothing rate-limits
 * requests anywhere in the tree.
 *
 * **Why that overshoot is written down rather than locked away.** The obvious fix —
 * `pg_advisory_xact_lock` on a fixed key around the count *and* the enqueue loop — makes
 * admission a global mutex held across up to 96 tile upserts plus 96 job upserts, on a
 * serverless deploy where every viewport that finds new ground takes it. That is a
 * transaction well past Prisma's five-second interactive budget on the area path, and it
 * converts a bounded overshoot into a queue every map request waits behind. It is the right
 * fix once there is a rate limiter in front of it — `packages/api/src/context.ts` already
 * carries the note that one belongs there — because then the lock is only ever contended by
 * a handful of callers. Until then the ceiling is soft by a bounded multiple, and this
 * paragraph is what stops the next reader believing otherwise.
 *
 * Two limits, because they fail differently:
 *
 * - **Queue depth** is about *time*. A deep queue is not dangerous, it is slow, and the
 *   damage is that every live viewport sits behind hours of ground nobody is looking at.
 * - **Database size** is about *space*, and that one is terminal. Six hundred jobs times
 *   `MAX_TILE_BYTES` is 7.2 GB of fetched OSM, nothing reclaims a row, and a full database
 *   does not degrade — it stops accepting writes, which takes sign-in and activity recording
 *   down with the map.
 *
 * And one number that is deliberately *not* a limit: the derived backlog. It is counted and
 * logged, never refused on. `DERIVED_QUEUE_WARN_DEPTH` carries the argument, and it is the
 * one worth reading before adding a third ceiling here — **a ceiling is only honest on a
 * queue this deploy can drain**, and that is a claim about the drain, not about the size of
 * the fan-out. Both blockers this module has shipped were the same mistake in different
 * clothes: a limit whose real denominator was never measured.
 *
 * The failure mode both real limits produce is the same and is chosen deliberately: **the
 * map stops filling, and says so.** Reads keep working, everything already ingested still
 * draws, and the reader gets a sentence explaining why nothing new is arriving. That is a
 * bad afternoon. A database at 100% is a bad week.
 */

import { JobKind, JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';

/**
 * Refuse to queue new ingest past this many *requested* jobs already waiting.
 *
 * Six hundred is roughly six area presses' worth, or an hour of drain at the rate the
 * Overpass client's concurrency limit allows. Past it, a new tile would not be fetched any
 * sooner for being queued, so queueing it buys nothing and costs a row.
 */
export const MAX_TILE_QUEUE_DEPTH = 600;

/**
 * The kinds a *request* can put on the queue. These are what `MAX_TILE_QUEUE_DEPTH` counts.
 *
 * The original guard counted `ingest_tile` alone while the routing queue enqueued
 * `ingest_network`, so the routing queue was invisible to the only thing watching — a
 * second, unbounded queue sharing the same database and the same Overpass budget.
 *
 * `refresh_tile` has no producer anywhere in the tree: it exists in `JobKind` and in the
 * handler table, and nothing enqueues one. Counted anyway rather than dropped, because it
 * is a request-shaped kind with a live handler, so the day something does enqueue one it is
 * already inside the ceiling. The failure this module exists to prevent is a kind growing
 * outside the count; an enum member that always contributes zero is the cheaper mistake.
 */
export const REQUEST_JOB_KINDS = [
  JobKind.ingest_tile,
  JobKind.refresh_tile,
  JobKind.ingest_network,
] as const;

/**
 * The kinds the *drain* produces while running the kinds above. Counted, never gated.
 *
 * `enrich_trail` is enqueued once per committed trail by `pipeline.ts`, and `ingest_route`
 * once per superroute — the most expensive job in the package. Neither can be requested;
 * both are fan-out from a tile that was already admitted. Leaving them uncounted was the
 * same bug the `ingest_network` fix was written to close: production is carrying 5,310
 * queued `enrich_trail` and 7 queued `ingest_route` against 74 counted request jobs, so the
 * guard was watching 1.4% of its own queue while the other 98.6% wrote photos and metadata
 * into the database the storage half is meant to protect.
 *
 * Counting them is right. **Refusing on them was not, and the version of this file that did
 * so was a shipping blocker** — see `DERIVED_QUEUE_WARN_DEPTH` for the whole argument.
 */
export const DERIVED_JOB_KINDS = [JobKind.enrich_trail, JobKind.ingest_route] as const;

/** Every kind the guard counts, in one list so it can be read in one query. */
export const INGEST_JOB_KINDS = [...REQUEST_JOB_KINDS, ...DERIVED_JOB_KINDS] as const;

/**
 * Say so, once, when the derived backlog is this deep. **This does not refuse anything.**
 *
 * It used to, as `MAX_DERIVED_QUEUE_DEPTH = 20_000`, and that was a one-way latch — a
 * ceiling on a queue this deploy cannot drain. Review caught it; the mechanism is worth
 * writing down, because the mistake is easy to make again and every individual step of it
 * looks reasonable.
 *
 * Derived jobs are enqueued at `priority: -10` (`pipeline.ts`), the lowest value anything
 * uses, and `claimJobs` orders `priority DESC, "runAfter" ASC`. So while a single request
 * job is runnable, a derived job is never claimed at all. The only unscoped drainer in
 * production is the Vercel cron, which claims `BATCH` jobs on `17 4 * * *` — once a day.
 * Both inline kicks are `dedupeKeys`-scoped to the tiles they just queued and so cannot
 * reach a derived job by construction. Net drain rate: a theoretical few jobs a day, a
 * practical zero whenever request work exists.
 *
 * Against that, the arithmetic of the old ceiling: production sat at 5,317 derived jobs of
 * 20,000, measured fan-out is ~339 `enrich_trail` per z9 tile, and one unauthenticated
 * `trails.fetchArea` may queue `MAX_AREA_TILES` = 96 tiles. That is ~32,500 derived jobs
 * from one POST against 14,683 of headroom — 2.2x over, in a single call. Past the ceiling,
 * `admitIngest` refused *every* enqueue on *every* path, and nothing in the tree could bring
 * the count back down: a queued job leaves only by running (starved) or by exhausting five
 * attempts (five cron claims each), and `pruneFinishedJobs` deletes only terminal rows. One
 * stranger, one request, ingest off product-wide, permanently. The copy made it worse — the
 * refusal arrived as `'queue-depth'`, so the reader was told to try again in a few minutes
 * about a backlog that clears in years.
 *
 * Two things changed and both were needed. The gate is gone, which is this constant. And
 * the starvation is fixed: every drain now claims a guaranteed share of derived work
 * regardless of priority (`drainJobs`' `derivedLimit`, wired into the cron and both inline
 * kicks), so the backlog moves at the rate the traffic that creates it moves. Write
 * amplification is the storage half's job — that is the lever with a real denominator now
 * that production is on Azure with a known quota. See `.env.example`.
 *
 * Twenty thousand is kept as the number worth *saying*, on the same anchor it always had:
 * production holds 19,157 trails, so it is roughly "every trail we have ever ingested is
 * waiting to be enriched", which is a backlog that has stopped draining rather than one that
 * is merely deep. A log line is the right response to that. A refusal was not.
 */
export const DERIVED_QUEUE_WARN_DEPTH = 20_000;

/**
 * How full the database may get before new ingest is refused.
 *
 * Not 100%, because the point is to stop *before* the writes that matter start failing. The
 * fifteen percent left over is what sign-ins, activity uploads, reviews and the drain's own
 * bookkeeping run on while an operator decides what to delete.
 */
export const MAX_STORAGE_FRACTION = 0.85;

/** How long a database-size reading is trusted. */
export const STORAGE_CACHE_MS = 60_000;

/** How often the derived backlog may be mentioned in the log. */
export const DERIVED_WARN_INTERVAL_MS = 10 * 60_000;

/** Why ingest was refused, or `null` when it was not. */
export type IngestRefusal = 'queue-depth' | 'storage';

interface StorageReading {
  bytes: number;
  limit: number;
  readAt: number;
}

let cached: StorageReading | null = null;
let warnedUnconfigured = false;
let warnedProbeFailed = false;
let derivedWarnedAt = Number.NEGATIVE_INFINITY;

/** Test seam: forget the cached database size and the once-only warnings. */
export function resetStorageCache(): void {
  cached = null;
  warnedUnconfigured = false;
  warnedProbeFailed = false;
  derivedWarnedAt = Number.NEGATIVE_INFINITY;
}

/**
 * What `DATABASE_SIZE_LIMIT_BYTES` says, as one of three answers rather than two.
 *
 * `null` for "unset" and `null` for "unparseable" is the shape this had, and it made the one
 * log line the storage guard owns actively misdirect the person switching it on: set
 * `DATABASE_SIZE_LIMIT_BYTES=64GiB`, redeploy, grep the log, read *is unset*, and go looking
 * for a variable that arrived perfectly intact. `.env.example` presents the ceiling in prose
 * — "(0.5 GB)", "(10 GB)", "(64 GiB)" beside the raw integers — so a unit suffix is the most
 * likely thing an operator types, and it is exactly the input that produced the wrong line.
 *
 * `Number()` accepts a bare integer and nothing else useful here: `32GB`, `64GiB`, `32 GB`,
 * `34,359,738,368` and `10_737_418_240` are all `NaN`, and `0` and `-1` are non-positive.
 * All of them are now `invalid`, and `invalid` says so with the value in the message.
 */
type LimitReading =
  { kind: 'ok'; bytes: number } | { kind: 'unset' } | { kind: 'invalid'; raw: string };

/**
 * The database's size ceiling in bytes, or why there isn't one.
 *
 * A plan property rather than something Postgres will tell us — `pg_database_size` reports
 * what is used, and nothing reports what is allowed — so it has to be written down, and
 * until it is written down there is no fraction to compute.
 *
 * **This used to default to 512 MB, and that default was a shipping blocker.** The number
 * was a guess at a free tier's ceiling; `DATABASE_SIZE_LIMIT_BYTES` was set in no
 * environment and named in no manifest; and production was already at 483,172,352 bytes,
 * which is 90.0% of the guess. Run against the production database, `admitIngest` returned
 * `'storage'` — that is every enqueue in the product refused, permanently. Browse,
 * coverage, search, fetch-area and route planning all cross these two functions, and
 * nothing in the tree deletes a trail or a tile, so the fraction only ever rises.
 *
 * So the guard is opt-in. Unconfigured, it declines to have an opinion and the depth guard
 * carries the load alone — the same posture as a size probe that throws, because an
 * instrument nobody calibrated is not evidence of a full disk. Set it to the real quota of
 * the plan the database is on and the space half starts working. See `.env.example`.
 */
function databaseLimitBytes(): LimitReading {
  const raw = process.env.DATABASE_SIZE_LIMIT_BYTES;
  if (raw === undefined || raw.trim() === '') return { kind: 'unset' };

  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0
    ? { kind: 'ok', bytes: configured }
    : { kind: 'invalid', raw };
}

/**
 * How much of the database is used, cached for a minute. `null` means no opinion.
 *
 * Cached because this sits in front of `trails.browse`, which every pan and zoom fires:
 * uncached, it would add a round trip to every map movement in the product to answer a
 * question whose answer moves by kilobytes a minute. Sixty seconds is far quicker than the
 * database can plausibly fill and cheap enough to be invisible.
 *
 * Returns `null` when it cannot tell, and the caller treats that as permission. A size probe
 * that fails is a broken instrument, not a full disk, and an instrument failure must not be
 * able to stop the map filling — the depth guard above is the one that has to hold.
 *
 * Three states produce `null`, and the log distinguishes all three, because they need three
 * different actions from whoever is reading it: set the variable, fix the value, or go and
 * find out why the database will not answer `pg_database_size`. They used to produce one
 * wrong line and one silence between them.
 */
async function storageFraction(db: PrismaClient, now: number): Promise<number | null> {
  const reading = databaseLimitBytes();

  if (reading.kind !== 'ok') {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      // Once per process, because this runs behind every viewport. An operator who wants the
      // space guard has to be told it is switched off, and told which of the two reasons it
      // is off for — "unset" printed at a variable that was set is how a five-minute fix
      // becomes an afternoon in the deployment settings.
      console.warn(
        reading.kind === 'unset'
          ? 'ingest storage guard is off: DATABASE_SIZE_LIMIT_BYTES is unset, so only the queue-depth ceiling applies'
          : `ingest storage guard is off: DATABASE_SIZE_LIMIT_BYTES="${reading.raw}" is not a positive integer of bytes (no units, no separators), so only the queue-depth ceiling applies`,
      );
    }
    return null;
  }

  const limit = reading.bytes;

  if (cached && cached.limit === limit && now - cached.readAt < STORAGE_CACHE_MS) {
    return cached.bytes / cached.limit;
  }

  try {
    const rows = await db.$queryRaw<Array<{ bytes: bigint }>>`
      SELECT pg_database_size(current_database()) AS bytes
    `;
    const raw = rows[0]?.bytes;
    if (raw === undefined) return null;

    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;

    cached = { bytes, limit, readAt: now };
    return cached.bytes / cached.limit;
  } catch (error) {
    // Once per process, and only reachable with the variable *set*: somebody asked for this
    // guard and it is not running. The silent version of this catch meant "configured and
    // working" and "configured and the probe throws" looked identical from outside — no
    // line either way — which is the state an operator is least able to diagnose and most
    // likely to be in, since a stand-in client without `$queryRaw` lands here too.
    if (!warnedProbeFailed) {
      warnedProbeFailed = true;
      console.warn(
        'ingest storage guard is off: pg_database_size could not be read, so only the queue-depth ceiling applies',
        error,
      );
    }
    return null;
  }
}

/**
 * May new ingest be queued? `null` means yes.
 *
 * Depth first, because it is one grouped count against a table we are about to write to
 * anyway, and it is the limit that trips in ordinary abuse. The size read only happens on
 * the calls that get past it, and at most once a minute.
 *
 * One query covers both ceilings: request kinds and derived kinds come back in the same
 * `groupBy` and are split here, rather than paying two round trips to ask one table two
 * questions. It rides `@@index([kind, status])` on `IngestJob` — the version of this that
 * called itself "one indexed count" planned as a sequential scan, because the only usable
 * index started at `status` and the planner would not use it for a `kind` filter:
 * `Rows Removed by Filter: 5332` against 74 matched, on production. The index is new with
 * this change, and so is the drain's prune of terminal jobs, without which the scan grew
 * with lifetime job count rather than with queue depth.
 */
export async function admitIngest(
  db: PrismaClient,
  now: number = Date.now(),
): Promise<IngestRefusal | null> {
  const rows = await db.ingestJob.groupBy({
    by: ['kind'],
    where: {
      kind: { in: [...INGEST_JOB_KINDS] },
      status: { in: [JobStatus.queued, JobStatus.running] },
    },
    _count: { _all: true },
  });

  const depthOf = (kinds: readonly JobKind[]): number =>
    rows.reduce((sum, row) => (kinds.includes(row.kind) ? sum + row._count._all : sum), 0);

  const requested = depthOf(REQUEST_JOB_KINDS);
  if (requested >= MAX_TILE_QUEUE_DEPTH) {
    // The line an operator greps for. Every refusal names the number it tripped, because
    // "ingest refused" without one tells you the guard fired and nothing about whether it
    // fired correctly.
    console.warn(
      `ingest refused: queue depth ${requested} at or past the ${MAX_TILE_QUEUE_DEPTH} ceiling`,
    );
    return 'queue-depth';
  }

  // Reported, never refused on. See `DERIVED_QUEUE_WARN_DEPTH` for why gating on this queue
  // was a latch nothing could unlatch. Rate-limited rather than once-per-process, because a
  // backlog that crosses the mark at 03:00 and is still over it at noon is worth saying
  // twice, and this runs behind every viewport.
  const derived = depthOf(DERIVED_JOB_KINDS);
  if (derived >= DERIVED_QUEUE_WARN_DEPTH && now - derivedWarnedAt >= DERIVED_WARN_INTERVAL_MS) {
    derivedWarnedAt = now;
    console.warn(
      `ingest backlog: ${derived} derived jobs outstanding, at or past the ${DERIVED_QUEUE_WARN_DEPTH} mark — enrichment is not keeping up with ingest`,
    );
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
