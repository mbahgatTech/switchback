/**
 * Admission control for the ingest queue — two ceilings, queue depth and database size.
 * Asked inside `queueTiles`/`queueNetworkTiles`, the choke point every writing path crosses.
 */

import { JobKind, JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { hoursToDrain, queueDepthForHours } from './drain-rate';

/**
 * How long a tile admitted at the ceiling may still be waiting to be fetched.
 *
 * The primitive, with `MAX_TILE_QUEUE_DEPTH` its consequence: a job count states no promise a
 * reader can check against the drain, and an hours figure does. Eighteen sits just above a floor
 * rather than being a preference. One press of "fetch this area" is `MAX_AREA_TILES` = 96 tiles =
 * 3.4 hours of serial drain, and below `MAX_AREA_TILES / PRINCIPAL_QUEUE_SHARE` = 480 jobs, or
 * 16.8 hours, the per-caller allowance in `rate-limit.ts` stops being a share of this ceiling and
 * becomes a clamp above it. A shorter horizon needs a smaller area fetch first: that is the lever.
 */
export const MAX_QUEUE_WAIT_HOURS = 18;

/**
 * Refuse new ingest past this many *requested* jobs already waiting, past which queueing buys no
 * earlier fetch. Derived from measured throughput so the wait it admits cannot drift from the wait
 * the estate delivers.
 */
export const MAX_TILE_QUEUE_DEPTH = queueDepthForHours(MAX_QUEUE_WAIT_HOURS);

/**
 * The kinds a *request* can put on the queue — all that `MAX_TILE_QUEUE_DEPTH` counts.
 * `refresh_tile` has no producer yet; keep it listed so the day one appears it is already
 * inside the ceiling.
 */
export const REQUEST_JOB_KINDS = [
  JobKind.ingest_tile,
  JobKind.refresh_tile,
  JobKind.ingest_network,
] as const;

/** Fan-out the drain produces from an already-admitted tile. Counted, never refused on. */
export const DERIVED_JOB_KINDS = [JobKind.enrich_trail, JobKind.ingest_route] as const;

/** Every kind the guard counts, in one list so it can be read in one query. */
export const INGEST_JOB_KINDS = [...REQUEST_JOB_KINDS, ...DERIVED_JOB_KINDS] as const;

/**
 * Say so, once, when the derived backlog is this deep. **This must not become a refusal.**
 * Derived jobs sit at the lowest priority and only the daily cron claims them unscoped, so a
 * backlog past the mark clears in years — the version that gated on it latched ingest off
 * product-wide with nothing in the tree able to bring the count back down. 20,000 is about
 * "every trail we have ever ingested is waiting to be enriched".
 */
export const DERIVED_QUEUE_WARN_DEPTH = 20_000;

/**
 * How full the database may get before new ingest is refused. Not 100%: the remainder is what
 * sign-ins, uploads, reviews and the drain's own bookkeeping run on while an operator decides.
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

/** Unset and unparseable are separate answers so the log can say which one to fix. */
type LimitReading =
  { kind: 'ok'; bytes: number } | { kind: 'unset' } | { kind: 'invalid'; raw: string };

/**
 * The database's size ceiling in bytes, or why there isn't one — nothing in Postgres reports
 * what a plan allows. Deliberately opt-in with no default: a guessed 512 MB default once put
 * production past the fraction and refused every enqueue in the product. See `.env.example`.
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
 * How much of the database is used, cached for a minute because this sits in front of every
 * pan and zoom. `null` means no opinion, and the caller treats that as permission: a size
 * probe that fails is a broken instrument, not a full disk.
 */
async function storageFraction(db: PrismaClient, now: number): Promise<number | null> {
  const reading = databaseLimitBytes();

  if (reading.kind !== 'ok') {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      // Once per process — this runs behind every viewport.
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
    // Only reachable with the variable set: somebody asked for this guard and it is not
    // running, so silence here is the state an operator is least able to diagnose.
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
 * May new ingest be queued? `null` means yes. Depth first — it is the ceiling ordinary abuse
 * trips — and one `groupBy` answers both, riding `@@index([kind, status])` on `IngestJob`.
 *
 * The ceiling is soft: tRPC starts every call in a batch concurrently and this count is
 * unlocked, so one request can overshoot by batch size times the per-call tile cap. The fix is
 * a rate limiter in front (see `packages/api/src/context.ts`), not a lock across 96 upserts.
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
    // Every refusal names the number it tripped, so a grep can tell a correct fire from a bug, and
    // the wait that number stands for, so a log line can be judged without opening this file.
    console.warn(
      `ingest refused: queue depth ${requested} at or past the ${MAX_TILE_QUEUE_DEPTH} ceiling, ` +
        `${hoursToDrain(requested).toFixed(1)} h of drain at the measured rate`,
    );
    return 'queue-depth';
  }

  // Reported, never refused on — see `DERIVED_QUEUE_WARN_DEPTH`. Rate-limited rather than
  // once-per-process, because this runs behind every viewport.
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
