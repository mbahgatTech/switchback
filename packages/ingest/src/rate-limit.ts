/**
 * Per-caller admission control: a token bucket, priced in tiles, spent when a request puts *new*
 * ground on the ingest queue. Sits behind the product-wide ceilings in `backpressure.ts` and
 * bounds how much of them any one caller may take.
 */

import { Prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { MAX_TILE_QUEUE_DEPTH } from './backpressure';

/**
 * Who an enqueue is charged to. `key` is what the bucket is keyed on and is never a raw network
 * address; `kind` exists so a log line can say how the caller was identified without decoding it.
 */
export interface IngestPrincipal {
  key: string;
  kind: 'user' | 'address' | 'unidentified';
}

/** Ingest refused because this caller has spent its allowance. Nobody else is affected. */
export type RateRefusal = 'rate-limit';

/**
 * The share of the product-wide request-queue ceiling one caller may hold. Derived rather than
 * written down, so re-measuring `MAX_TILE_QUEUE_DEPTH` re-tunes this with it. At a fifth it
 * takes five simultaneous abusers to fill the queue for everybody, where it took one.
 */
export const PRINCIPAL_QUEUE_SHARE = 0.2;

/**
 * The allowance can never fall below one deliberate area fetch, or the "fetch this area" button
 * is dead for everyone from the moment somebody lowers the ceiling. Kept equal to
 * `MAX_AREA_TILES` by `rate-limit.db.test.ts` rather than imported, which would be a cycle.
 */
export const MIN_BUCKET_CAPACITY = 96;

/** Tiles of new ground one caller may enqueue in a burst. */
export const BUCKET_CAPACITY = Math.max(
  MIN_BUCKET_CAPACITY,
  Math.floor(MAX_TILE_QUEUE_DEPTH * PRINCIPAL_QUEUE_SHARE),
);

/**
 * How long an empty bucket takes to fill. Long enough that sustained hammering costs more than
 * the queue drains, short enough that a reader who tripped it is panning over new ground again
 * within a few minutes rather than being locked out of the map.
 */
export const BUCKET_REFILL_MS = 30 * 60_000;

/** How often one process may mention a rate-limited caller. This runs behind every viewport. */
export const RATE_WARN_INTERVAL_MS = 60_000;

const TOKENS_PER_SECOND = BUCKET_CAPACITY / (BUCKET_REFILL_MS / 1000);

let warnedAt = Number.NEGATIVE_INFINITY;

/** Test seam: forget the once-per-interval log state. */
export function resetIngestBudgetState(): void {
  warnedAt = Number.NEGATIVE_INFINITY;
}

/** What a spend attempt did. `remaining` is null when there was not enough to take. */
export interface BudgetOutcome {
  spent: boolean;
  remaining: number | null;
}

/**
 * What the bucket holds at `now`, capped at the allowance. Elapsed time is clamped at zero
 * because Vercel runs many instances and nothing synchronises their clocks — a reading from a
 * fast one must not be able to drain a bucket a slow one then reads.
 */
function refilled(now: Date): Prisma.Sql {
  return Prisma.sql`LEAST(
    ${BUCKET_CAPACITY}::float8,
    b.tokens + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - b."refilledAt")))
               * ${TOKENS_PER_SECOND}::float8
  )`;
}

/**
 * Take `cost` tiles from this caller's allowance, or refuse. One statement rather than a read
 * and a write: instances do not share memory and this is the only thing standing between one
 * client and the whole queue, so the check and the spend have to be the same operation.
 */
export async function spendIngestBudget(
  db: PrismaClient,
  principal: IngestPrincipal,
  cost: number,
  now: Date = new Date(),
): Promise<BudgetOutcome> {
  if (cost <= 0) return { spent: true, remaining: null };

  if (cost > BUCKET_CAPACITY) {
    // Unreachable while `MIN_BUCKET_CAPACITY` holds — every caller-facing path is capped at
    // `MAX_AREA_TILES` or below — and a refusal beats letting a bucket go negative.
    console.warn(
      `ingest refused: ${cost} tiles asked for at once, past the ${BUCKET_CAPACITY}-tile allowance`,
    );
    return { spent: false, remaining: null };
  }

  const available = refilled(now);
  const rows = await db.$queryRaw<Array<{ tokens: number }>>(Prisma.sql`
    INSERT INTO ingest_rate_buckets AS b (principal, tokens, "refilledAt")
    VALUES (${principal.key}, ${BUCKET_CAPACITY - cost}::float8, ${now}::timestamptz)
    ON CONFLICT (principal) DO UPDATE
       SET tokens = ${available} - ${cost}::float8,
           "refilledAt" = ${now}::timestamptz
     WHERE ${available} >= ${cost}::float8
    RETURNING tokens
  `);

  const granted = rows[0];
  if (granted !== undefined) return { spent: true, remaining: granted.tokens };

  const at = now.getTime();
  if (at - warnedAt >= RATE_WARN_INTERVAL_MS) {
    warnedAt = at;
    console.warn(
      `ingest refused: ${principal.kind} ${principal.key} asked for ${cost} more tiles than its ${BUCKET_CAPACITY}-tile allowance holds`,
    );
  }
  return { spent: false, remaining: null };
}

/**
 * Drop buckets that have refilled to the allowance. A full row and a missing row are the same
 * answer, so this is retention rather than state — it is safe to run at any time, and safe to
 * run never, at the cost of one row per caller seen.
 */
export async function pruneIngestBuckets(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const settled = new Date(now.getTime() - BUCKET_REFILL_MS);
  const { count } = await db.ingestRateBucket.deleteMany({
    where: { refilledAt: { lt: settled } },
  });
  return count;
}
