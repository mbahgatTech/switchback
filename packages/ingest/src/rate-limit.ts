/**
 * Per-caller admission control: a token bucket, priced in tiles, spent when a request puts *new*
 * ground on the ingest queue. Sits behind the product-wide ceilings in `backpressure.ts` and
 * bounds how much of them any one caller may take.
 */

import { Prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { MAX_TILE_QUEUE_DEPTH } from './backpressure';
import { REQUEST_DRAIN_TILES_PER_HOUR } from './drain-rate';

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
 * written down, so re-measuring `MAX_TILE_QUEUE_DEPTH` re-tunes this with it.
 *
 * At a fifth it takes five *buckets* to fill the queue for everybody where it took one — which is
 * not the same as five people, and this line previously said "abusers" as though it were. An
 * anonymous caller is keyed by IPv6 `/64`, and one residential customer with a routed `/56` holds
 * 256 of those. Five buckets can be one household, and what a fresh key is worth is the full
 * burst, which nothing here paces. Tune against that, not against a headcount. Signed-in callers
 * are keyed by account, where none of this applies.
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
 * Tiles per hour one caller may sustain: their share of what the estate measurably drains.
 *
 * The number an allowance has to respect. Granting one caller more than a share of it promises work
 * the estate cannot do, and the queue that promise fills is the one every other reader waits behind.
 * Request kinds only, because that is what a bucket prices, and `MAX_TILE_QUEUE_DEPTH` is sized
 * from the same figure — so the allowance and the ceiling it is a share of move together.
 */
export const PRINCIPAL_TILES_PER_HOUR = REQUEST_DRAIN_TILES_PER_HOUR * PRINCIPAL_QUEUE_SHARE;

/**
 * How long an empty bucket takes to refill: the allowance divided by the sustained rate, so the
 * burst and the rate are tuned by two separate numbers rather than one.
 *
 * Derived rather than chosen, and the derivation is what holds the property. A fixed 30-minute
 * window refills a whole `BUCKET_CAPACITY` at many times `REQUEST_DRAIN_TILES_PER_HOUR`, which lets
 * one caller hold the product-wide ceiling indefinitely while every other reader sees
 * `queue-depth`. Pacing the refill by the drain instead makes that impossible at any allowance:
 * the burst is `BUCKET_CAPACITY`, the sustained rate is `PRINCIPAL_TILES_PER_HOUR`, and re-tuning
 * the ceiling moves the burst without touching the rate.
 */
export const BUCKET_REFILL_MS = Math.ceil((BUCKET_CAPACITY / PRINCIPAL_TILES_PER_HOUR) * 3_600_000);

/** How often one process may mention a rate-limited caller. This runs behind every viewport. */
export const RATE_WARN_INTERVAL_MS = 60_000;

/**
 * The measured rate is the primitive; `BUCKET_REFILL_MS` is a rounded consequence of it. Deriving
 * this back out of that rounded window instead leaves the bucket a float-rounding hair short of
 * full after exactly one window, so "wait the window out" did not refill it.
 */
const TOKENS_PER_SECOND = PRINCIPAL_TILES_PER_HOUR / 3600;

/**
 * When each principal's refusal was last logged. Per principal rather than one global mark: with
 * a single mark whichever caller trips first owns the whole budget, so a sustained abuser
 * silences the very line an operator is told to watch for everybody else.
 */
const warnedAt = new Map<string, number>();

/** Past this many tracked principals, drop the ones whose interval has already elapsed. */
const WARN_TRACKING_LIMIT = 1_000;

/** Test seam: forget the once-per-interval log state. */
export function resetIngestBudgetState(): void {
  warnedAt.clear();
}

/** Whether this principal may be logged now, recording the mention when it may. */
function mayWarn(key: string, at: number): boolean {
  const last = warnedAt.get(key);
  if (last !== undefined && at - last < RATE_WARN_INTERVAL_MS) return false;

  if (warnedAt.size >= WARN_TRACKING_LIMIT) {
    for (const [seen, when] of warnedAt) {
      if (at - when >= RATE_WARN_INTERVAL_MS) warnedAt.delete(seen);
    }
  }
  warnedAt.set(key, at);
  return true;
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
           -- Never backwards. Elapsed time is already clamped at zero for a slow instance, but
           -- writing its clock unclamped would rewind the row and hand the next normal-clock
           -- reader the skew as free tokens: 15 minutes of skew was measured granting 60.
           "refilledAt" = GREATEST(b."refilledAt", ${now}::timestamptz)
     WHERE ${available} >= ${cost}::float8
    RETURNING tokens
  `);

  const granted = rows[0];
  if (granted !== undefined) return { spent: true, remaining: granted.tokens };

  if (mayWarn(principal.key, now.getTime())) {
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
