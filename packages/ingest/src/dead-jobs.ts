/**
 * The way back from `dead`, which is the one terminal state nothing else reverses: `enqueue`
 * needs a caller, `queueStaleChildren` reaches split children only, and `reclaimExpiredJobs`
 * skips a dead row by predicate.
 */

import { JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { INGEST_ZOOM } from '@switchback/geo';
import { REQUEST_JOB_KINDS } from './backpressure';
import { DEADLINE_PASSED } from './deadline';
import {
  OVERPASS_BREAKER_OPEN,
  OVERPASS_BUDGET_SPENT,
  OVERPASS_MALFORMED_QL,
  OVERPASS_NON_JSON,
  OVERPASS_REMARK,
  OVERPASS_REQUEST_FAILED,
  OVERPASS_UA_REFUSED,
  OVERPASS_UA_UNREACHABLE,
  OVERPASS_UA_UNUSABLE,
  OVERPASS_UNPARSEABLE,
  RETRYABLE_STATUS,
} from './overpass';
import { SPLIT_CHILD_ATTEMPT_CAP } from './subdivide';
import {
  DEFAULT_MAX_ATTEMPTS,
  LEASE_EXPIRED_REASON_PREFIX,
  PAYLOAD_INCOMPLETE,
  namedKeys,
  tileJobKey,
} from './jobs';

/**
 * How long a burial waits before each revival, indexed by revivals already granted.
 *
 * A ladder rather than one delay, because the fault worth reviving for is an outage rather than a
 * blip: at a fixed short delay the whole budget is spent inside the first hour of one, and the job
 * is abandoned while its cause is still live. These three span 10.5 h of waiting, plus whatever
 * each attempt's own five-step `RETRY_DELAYS_MS` ladder takes before it buries the job again.
 */
export const REVIVAL_DELAYS_MS = [30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000] as const;

/**
 * The most attempts a revived job may reach, one rung of `REVIVAL_DELAYS_MS` each.
 *
 * **`maxAttempts` is the counter because it is the only durable one.** `enqueue` clears `attempts`
 * whenever it revives a terminal row, so a budget kept in `attempts` would restart on the next
 * viewport poll — the hazard `SPLIT_CHILD_ATTEMPT_CAP` keeps in `IngestTile.attempts` for exactly
 * the same reason. Raising it by one grants exactly one attempt: `claimJobs` increments `attempts`
 * to meet it, and `isFinalAttempt` buries the row again if that attempt fails.
 *
 * **The counter has to come back down, and `enqueue` is what brings it.** A raised ceiling that
 * outlived the reconciler would hand a fresh request nine attempts instead of five and, once
 * re-buried above the ladder, would sit outside every rung with nothing reporting it. So
 * `enqueue`'s revive arm resets this column alongside `attempts` and `priority`, and
 * `scripts/requeue-jobs.ts` does the same — both are a *new request*, not a continuation.
 */
export const REVIVAL_CEILING = DEFAULT_MAX_ATTEMPTS + REVIVAL_DELAYS_MS.length;

/**
 * What `maxAttempts` becomes when the reconciler gives up, and the predicate that stops it
 * deciding the same row twice.
 *
 * Recorded in an integer rather than in the `lastError` prose written beside it because
 * `lastError` is nullable, and `NOT (lastError LIKE '<marker>%')` evaluates to NULL — not true —
 * for a job buried with nothing recorded. That is precisely the unexplained death this has to
 * catch, so a predicate that silently drops it is the wrong one.
 */
export const ABANDONED_MAX_ATTEMPTS = REVIVAL_CEILING + 1;

/**
 * Priority a revived job re-enters at. Below `VIEWPORT_PRIORITY`, and that is the whole point.
 *
 * **A revival must not precede live work, and leaving the column alone was not neutral.** A tile
 * enqueued from a viewport carries `VIEWPORT_PRIORITY`; buried, revived and left at that band it
 * keeps it, and `claimJobs` orders `priority DESC, "runAfter" ASC` — so a stale revival with an
 * old `runAfter` is claimed *ahead* of the tile somebody is looking at right now. Not elevating a
 * revived row therefore produced the starvation that elevating one would have, through the
 * tie-break instead of the band.
 *
 * Zero is the band a background refresh uses: this is work that was asked for once, is no longer
 * being waited on, and should be done when nothing more urgent is. `packages/ingest/test/dead-jobs.test.ts`
 * asserts the relation against `VIEWPORT_PRIORITY` rather than the number, so moving either fails.
 *
 * Lowering is safe under concurrency for the reason `enqueue`'s reset arm is: the write is fenced
 * on the `dead` status it clears, so exactly one of two racing sweeps performs it.
 */
export const REVIVAL_PRIORITY = 0;

/**
 * How many revived request jobs may be outstanding — `queued` or `running` — at once.
 *
 * **This is the bound that keeps recovery from becoming an outage.** `admitIngest` counts
 * `REQUEST_JOB_KINDS` in `{queued, running}` against `MAX_TILE_QUEUE_DEPTH`; a `dead` row is not
 * counted and a revived one is, so *revival is the act that re-fills the ceiling*. The drain is
 * serial at a measured mean of 126.2 s (see `PUMP_QUEUE_DEPTH`), about 28 tiles an hour, while an
 * unbounded triage at 64 a tick injects 1,920 — sixty-eight times faster than the queue empties.
 * An Overpass outage burying a few hundred request tiles would then revive all of them inside
 * twenty minutes, return the depth to its ceiling, and have `admitIngest` refuse every new
 * viewport estate-wide for as long as the backlog took to drain.
 *
 * Thirty-two is a twentieth of the request ceiling, which is the property that matters: revival can
 * never be the reason `admitIngest` refuses a viewport.
 *
 * **The batch does not free in an hour, because of where these rows sort.**
 * `revive` writes `REVIVAL_PRIORITY`, below every request band, so a revived row is claimed after
 * everything else runnable — the batch frees at the rate the *whole* request queue drains, which
 * against a full queue is the better part of a day rather than an hour. Recovery of a large burial
 * is correspondingly slow, deliberately: the alternative costs live traffic.
 *
 * Not absolute starvation, either. `enqueue`'s third statement raises priority on a `queued` row,
 * so a revived tile a viewport touches is promoted to `VIEWPORT_PRIORITY` and drains normally —
 * the ground somebody is actually looking at recovers first.
 *
 * **Revival has no reserved share of the pump, and the condition is worth stating.** `runPump`
 * publishes `PUMP_QUEUE_DEPTH - PUMP_DERIVED_SHARE` primary rows a tick from the head of
 * `priority DESC, "runAfter" ASC`, and derived work is the only band with a reservation. So while
 * six or more request jobs sit above this band, revived rows are never published, stay `queued`,
 * hold the budget at zero, and revival pauses until the queue above them clears. That is the
 * intended precedence — live ground first — and it is the mechanism, not a fault; a reservation
 * here would be a second thing competing with the viewport for the same eight messages.
 *
 * **It still cannot latch, and this is the sentence that holds it.** If the count never fell, the
 * worst case is that revival pauses — which is the state the estate was in before any of this
 * existed. The failure mode is the status quo ante, never a new one.
 */
export const REVIVAL_OUTSTANDING_MAX = 32;

/**
 * How many buried jobs one pass considers.
 *
 * A window on the candidates, not a revival budget — `REVIVAL_OUTSTANDING_MAX` is that. What this
 * bounds is the work of *deciding*: a handful of statements and, at most, this many small writes
 * per window.
 *
 * **The window has to be sized against thirty days, not against an hour.** `queueHealth`'s
 * `dead` gauge is `completedAt >= now - DISTRESS_WINDOW_MS`, so it reports burials *per hour* and
 * not a standing population. The set this selects from is every `dead` request row past its rung,
 * bounded only by `FAILED_JOB_TTL_MS` — three orders of magnitude more than the gauge shows.
 *
 * Both selections filter on `(kind, status)` and sort on `completedAt`, which is why that index
 * carries `completedAt` as its third column: without it each pass is a scan of the dead partition
 * and a sort over some thousands of rows, on a timer that runs ahead of the tick's publish.
 */
export const TRIAGE_LIMIT = 64;

/**
 * The literal `switchback-ingest-drain-degraded` greps for.
 *
 * Severity 3 rather than 2 because it names a repair rather than a fault: the bound on it is
 * `REVIVAL_CEILING`, and what a reader wants from this line is a rate.
 */
export const JOB_REVIVED_MARKER = 'switchback-ingest-job-revived';

/**
 * The literal `switchback-ingest-ground-lost` greps for, and the prefix written onto the row.
 *
 * This is the end of every automatic path: the job stays `dead`, no sweep considers it again, and
 * `scripts/requeue-jobs.ts` or `fetchArea` is the way back. Reported on the tick the decision is
 * taken and never again, because the write moves the row out of the predicate that selected it.
 */
export const JOB_ABANDONED_MARKER = 'switchback-ingest-job-abandoned';

/** Whether a retry of this job is a different request or the same one. */
export type DeathCause = 'transient' | 'permanent' | 'unknown';

/** What killed a job, and the rule that decided — the reason is what the log line carries. */
export interface Death {
  cause: DeathCause;
  reason: string;
}

/** One phrasing that identifies a cause. A registry, so a new fault is a row rather than a branch. */
interface CauseRule {
  name: string;
  pattern: RegExp;
}

/**
 * Failures a retry repeats rather than survives, every pattern built from the constant its raising
 * module exports.
 *
 * **Only this list is enumerated, and that asymmetry is deliberate.** Reviving costs at most
 * `REVIVAL_DELAYS_MS.length` bounded attempts and the ladder is the safety; abandoning writes a
 * terminal mark that neither documented recovery fully reverses. So the burden of proof sits on
 * retiring a job, not on retrying one, and a phrasing nobody has enumerated gets the ladder.
 */
const PERMANENT_CAUSES: readonly CauseRule[] = [
  { name: 'the Overpass query is malformed', pattern: literal(OVERPASS_MALFORMED_QL) },
  { name: 'the mirror refused this User-Agent', pattern: literal(OVERPASS_UA_REFUSED) },
  { name: 'OVERPASS_USER_AGENT is not configured', pattern: literal(OVERPASS_UA_UNUSABLE) },
  // Its sibling throw. Both are a misconfigured setting, and neither improves by being retried.
  { name: 'OVERPASS_USER_AGENT reaches nobody', pattern: literal(OVERPASS_UA_UNREACHABLE) },
  { name: 'the job payload is incomplete', pattern: literal(PAYLOAD_INCOMPLETE) },
  {
    /*
     * Every status Overpass answers that `RETRYABLE_STATUS` does not list — 400, 404, 500 and the
     * rest. Derived from that set rather than enumerated beside it: 500 is deliberately absent
     * there ("almost always our own query being wrong"), and a second hand-kept list is one edit
     * away from having the reconciler retry the broken query the first list exists to stop.
     */
    name: 'Overpass refused the query itself',
    pattern: nonRetryableStatus(),
  },
];

/**
 * Failures about the moment rather than about the work. Named so the log says which, and so an
 * operator reading a revival knows what it is waiting out.
 *
 * Everything not matched here still gets the ladder — see `classifyDeath`. These names exist for
 * the report, not for the decision.
 */
const TRANSIENT_CAUSES: readonly CauseRule[] = [
  { name: 'the host killed the handler', pattern: literal(LEASE_EXPIRED_REASON_PREFIX) },
  { name: 'Overpass refused or failed', pattern: retryableStatus() },
  { name: 'Overpass spent its whole budget', pattern: literal(OVERPASS_BUDGET_SPENT) },
  { name: 'the Overpass breaker was open', pattern: literal(OVERPASS_BREAKER_OPEN) },
  /*
   * The three shapes an overloaded mirror answers 200 with. `assertUsable` raises each precisely
   * so `attempt` retries and rotates, which makes them the signature of the fault this ladder
   * exists to span — the one class of death it would be worst to retire half an hour in.
   */
  { name: 'Overpass answered with an error page', pattern: literal(OVERPASS_NON_JSON) },
  { name: 'Overpass answered unparseable JSON', pattern: literal(OVERPASS_UNPARSEABLE) },
  { name: 'Overpass reported the query failed', pattern: literal(OVERPASS_REMARK) },
  { name: 'every Overpass mirror refused', pattern: literal(OVERPASS_REQUEST_FAILED) },
  { name: 'the invocation ran out of clock', pattern: literal(DEADLINE_PASSED) },
  {
    name: 'the network failed',
    pattern: /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|aborted/,
  },
  {
    // Prisma and Postgres phrasings. These stay literals: they are not this repository's text.
    name: 'the database was unreachable',
    pattern:
      /reach database server|Connection terminated|Timed out fetching a new connection|too many clients/,
  },
];

/** Every rule, so a test can assert that each one still matches something the estate raises. */
export const CAUSE_RULES: readonly { cause: DeathCause; name: string }[] = [
  ...PERMANENT_CAUSES.map((rule) => ({ cause: 'permanent' as const, name: rule.name })),
  ...TRANSIENT_CAUSES.map((rule) => ({ cause: 'transient' as const, name: rule.name })),
];

/** A constant matched as itself. The fragments come from this repository and carry no metacharacter. */
function literal(fragment: string): RegExp {
  return new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function retryableStatus(): RegExp {
  return new RegExp(`Overpass (${[...RETRYABLE_STATUS].join('|')}) from`);
}

function nonRetryableStatus(): RegExp {
  return new RegExp(`Overpass (?!(?:${[...RETRYABLE_STATUS].join('|')})\\b)\\d{3} from`);
}

/**
 * Read a burial's `lastError` for whether running the job again is a different request.
 *
 * **Anything unrecognised is retried, not retired**, and the direction is the correction that
 * matters most here. `OverpassClient` treats a busy dispatcher's XHTML error page, an unparseable
 * body and a `runtime error: Query timed out` remark as retryable and rotates mirrors on each —
 * they are the *signature* of the overload this ladder exists to span — yet none of them is a
 * phrasing worth enumerating. Enumerating the permanent side and defaulting the rest to the
 * ladder puts the burden of proof on the terminal write, where it belongs — an enumerated
 * transient side retires exactly these rows half an hour into the outage they describe.
 */
export function classifyDeath(lastError: string | null): Death {
  if (lastError === null || lastError.trim() === '') {
    return { cause: 'unknown', reason: 'the row records no error' };
  }

  const permanent = PERMANENT_CAUSES.find((rule) => rule.pattern.test(lastError));
  if (permanent) return { cause: 'permanent', reason: permanent.name };

  const named = TRANSIENT_CAUSES.find((rule) => rule.pattern.test(lastError));
  if (named) return { cause: 'transient', reason: named.name };

  return { cause: 'unknown', reason: 'no rule explains this failure — retried on the ladder' };
}

/**
 * What a split child past `SPLIT_CHILD_ATTEMPT_CAP` is retired as. Permanent because the cap is a
 * decision already taken, not a fault to wait out — the reason names the cap so an operator
 * reading the line knows `unsplitTile` is the lever rather than a requeue.
 */
const CAPPED_SPLIT_CHILD_DEATH: Death = {
  cause: 'permanent',
  reason: 'a split child past SPLIT_CHILD_ATTEMPT_CAP — unsplitTile is the way back',
};

/** A job no automatic path will run again, and why it was given up on. */
export interface AbandonedJob {
  dedupeKey: string;
  cause: DeathCause;
  reason: string;
}

/** What one pass decided. Both lists are what the caller logs; neither is a count of the backlog. */
export interface DeadJobTriage {
  /** Buried jobs granted one more attempt. */
  revived: string[];
  /** Buried jobs the reconciler has finished with. */
  abandoned: AbandonedJob[];
}

/** The columns a triage decision is taken from. */
interface BuriedJob {
  id: string;
  dedupeKey: string;
  maxAttempts: number;
  lastError: string | null;
}

/** What one pass may do. `revive: false` is the operator brake — see `ingestPump`. */
export interface TriageOptions {
  /** Grant attempts this pass. False still abandons, which needs no queue capacity. */
  revive?: boolean;
  limit?: number;
}

/**
 * Decide what happens to every buried job that is due one, reviving the transient and retiring
 * the rest.
 *
 * **Only `REQUEST_JOB_KINDS` are selected, because that is the population the budget bounds.**
 * `revivalBudget` counts outstanding revivals of request kinds alone — what `admitIngest` weighs —
 * so selecting a derived kind would spend a slot in memory that the next pass never counts back,
 * and the cap would refill in full every tick. Nothing downstream absorbs that: `REVIVAL_PRIORITY`
 * is ten bands above the floor derived work enqueues at, so a revived row would outrank the whole
 * overdue backlog inside `runPump`'s two-message reservation, and `revive` clears `completedAt`,
 * which is the column `pruneFinishedJobs` deletes on — an unclaimed revival would escape both TTLs
 * on a table `trails.browse` counts on the hot path. A dead derived row therefore keeps the
 * behaviour it has today: buried, and collected at `FAILED_JOB_TTL_MS`.
 *
 * **Due-ness is a pair, not a date.** Each rung of `REVIVAL_DELAYS_MS` names the `maxAttempts` it
 * applies to, so a job waiting out its eight-hour rung is not selected at all rather than selected
 * and skipped — which is what keeps a long-waiting row from filling the window and starving the
 * ones that are ready.
 *
 * **A split child past its cap is retired here, not skipped.** `queueStaleChildren` revives a dead
 * child up to `SPLIT_CHILD_ATTEMPT_CAP` runs, counted in `IngestTile.attempts` because the job's
 * own counter resets on every revival; a child it has given up on is still `dead` with a transient
 * `lastError`, so selecting on the job row alone would be a second automatic path through the
 * population that cap exists to close.
 *
 * Retiring rather than skipping is what keeps the window moving. A `continue` writes nothing, so
 * the row keeps its status, its rung and its `completedAt`, satisfies the same predicate next tick
 * and sorts to the head again — for ever, since nothing else clears it either: `queueStaleChildren`
 * refuses it for the same cap, `ensureCoverage` never sees a z10 row, and `enqueue` is never
 * reached. Sixteen fully-capped parents are sixty-four such rows, which is the whole window, and a
 * reconciler that skipped them would do nothing at all until `pruneFinishedJobs` deleted them
 * thirty days later. Retiring records the decision the cap already made, and takes the row out of
 * the predicate that selected it. `unsplitTile` is the way back.
 *
 * A `maxAttempts` outside the ladder is left alone in both directions — an unrecognised budget is
 * not a licence to retry against. Nothing enqueues one at rest, and the two paths that raise it,
 * this function and its own abandonment, both bring it back down through `enqueue`.
 */
export async function reconcileDeadJobs(
  db: PrismaClient,
  now: Date = new Date(),
  options: TriageOptions = {},
): Promise<DeadJobTriage> {
  const limit = options.limit ?? TRIAGE_LIMIT;
  const select = { id: true, dedupeKey: true, maxAttempts: true, lastError: true };
  let budget = options.revive === false ? 0 : await revivalBudget(db);

  /*
   * Two windows, not one, because a row this pass cannot act on must not occupy a slot a row it
   * can act on needs. Skipping for want of budget writes nothing, so `completedAt` does not move
   * and the row sorts first again next tick, for ever. Sharing one window therefore let a handful
   * of stuck revivals starve every retirement behind them — and under the brake, where the budget
   * is zero by construction, that was guaranteed rather than possible.
   */
  const retiring = await db.ingestJob.findMany({
    // The ladder is spent: no delay left to wait out, no budget needed, nothing to classify.
    where: {
      kind: { in: [...REQUEST_JOB_KINDS] },
      status: JobStatus.dead,
      maxAttempts: REVIVAL_CEILING,
    },
    orderBy: { completedAt: 'asc' },
    select,
    take: limit,
  });

  const due = REVIVAL_DELAYS_MS.map((delayMs, rung) => ({
    maxAttempts: DEFAULT_MAX_ATTEMPTS + rung,
    completedAt: { lt: new Date(now.getTime() - delayMs) },
  }));

  /*
   * **Ordered by what this pass can act on.** With budget, oldest first is fair: the burial that
   * has waited longest is revived first. With none, the only decision left on this window is
   * retiring a permanent cause — and such a row is retired the first time it is seen, so the ones
   * still outstanding are the ones never seen, which are the newest. Oldest-first would re-read
   * the same immovable transient rows every tick and never reach them.
   */
  const laddering = await db.ingestJob.findMany({
    where: { kind: { in: [...REQUEST_JOB_KINDS] }, status: JobStatus.dead, OR: due },
    orderBy: { completedAt: budget > 0 ? 'asc' : 'desc' },
    select,
    take: limit,
  });

  const triage: DeadJobTriage = { revived: [], abandoned: [] };
  const buried = [...retiring, ...laddering];
  if (buried.length === 0) return triage;

  const capped = await cappedSplitChildren(db, buried);

  for (const job of buried) {
    const death = capped.has(job.dedupeKey)
      ? CAPPED_SPLIT_CHILD_DEATH
      : classifyDeath(job.lastError);
    const spent = job.maxAttempts >= REVIVAL_CEILING;

    if (!spent && death.cause !== 'permanent') {
      // Out of budget is "not this tick", never "give up": abandoning here would retire a job for
      // the queue being busy, which is the one reason that says nothing about the job.
      if (budget <= 0) continue;
      if (await revive(db, job, now)) {
        triage.revived.push(job.dedupeKey);
        budget -= 1;
      }
      continue;
    }

    const reason = spent
      ? `revived ${REVIVAL_DELAYS_MS.length} times and died every time`
      : death.reason;
    if (await abandon(db, job, death.cause, reason)) {
      triage.abandoned.push({ dedupeKey: job.dedupeKey, cause: death.cause, reason });
    }
  }

  return triage;
}

/**
 * How many more revived request jobs may be outstanding — see `REVIVAL_OUTSTANDING_MAX`.
 *
 * `maxAttempts` above the default *is* the marker for a revived row, and it is exact because
 * `enqueue` resets the column: a row counted here was revived by this reconciler and has not since
 * been re-requested. Only `REQUEST_JOB_KINDS` are counted, because only those are what
 * `admitIngest` weighs against the ceiling this exists to protect — and `reconcileDeadJobs`
 * selects on the same list, so what is spent here is what is counted back next pass.
 */
async function revivalBudget(db: PrismaClient): Promise<number> {
  /*
   * Read once per pass and spent down in memory, so it bounds this pass rather than the table.
   * Two passes overlapping would each read the pre-revival count and could together exceed the
   * cap by one pass's worth. Not reachable today — `ingestPump` is the only caller and the host
   * runs one process — and the consequence would be a slightly deeper queue for one tick rather
   * than anything unbounded, which is why this is a note and not a lock.
   */
  const outstanding = await db.ingestJob.count({
    where: {
      kind: { in: [...REQUEST_JOB_KINDS] },
      status: { in: [JobStatus.queued, JobStatus.running] },
      maxAttempts: { gt: DEFAULT_MAX_ATTEMPTS },
    },
  });
  return Math.max(REVIVAL_OUTSTANDING_MAX - outstanding, 0);
}

/**
 * The dedupe keys among these that name a split child `queueStaleChildren` has already given up
 * on. Read from `ingest_tiles`, because the cap counts there and nothing on the job row carries it.
 *
 * Scoped to tiles deeper than `INGEST_ZOOM`: `IngestTile.attempts` is never reset, so a healthy z9
 * refreshed across a year would eventually cross the cap and stop being revivable, and the cap is
 * a statement about subdivision rather than about age.
 *
 * Read outside the revive's fence, so a child at one below the cap that a concurrent `processTile`
 * pushes to it can take one further run. Bounded at exactly one — the next pass reads the new
 * count — and `queueStaleChildren` reads the same column the same way, so this adds no race the
 * cap did not already carry.
 */
async function cappedSplitChildren(
  db: PrismaClient,
  buried: readonly BuriedJob[],
): Promise<Set<string>> {
  const quadkeys = buried
    .map((job) => job.dedupeKey)
    .filter((key) => key.startsWith(`${tileJobKey('')}`))
    .map((key) => key.slice(key.indexOf(':') + 1))
    .filter((quadkey) => quadkey.length > INGEST_ZOOM);
  if (quadkeys.length === 0) return new Set();

  const tiles: Array<{ quadkey: string }> = await db.ingestTile.findMany({
    where: { quadkey: { in: quadkeys }, attempts: { gte: SPLIT_CHILD_ATTEMPT_CAP } },
    select: { quadkey: true },
  });
  return new Set(tiles.map((tile) => tileJobKey(tile.quadkey)));
}

/**
 * Grant one more attempt and return the job to the queue, behind anything a reader is waiting on.
 *
 * Fenced on the `maxAttempts` the row was read at, for the reason `writeOutcome` is fenced on its
 * lease: two overlapping sweeps working from one reading would each grant an attempt, and the
 * budget would be spent at twice the rate its ladder describes.
 *
 * `runAfter` is `now` because the rung's delay has already been served, lying between the burial
 * and this tick; `priority` drops to `REVIVAL_PRIORITY` so that being due does not mean being
 * first. `lastError` survives, as it does through `enqueue`: until this attempt writes its own
 * outcome, why the last one failed is the only diagnostic the row carries.
 */
async function revive(db: PrismaClient, job: BuriedJob, now: Date): Promise<boolean> {
  const { count } = await db.ingestJob.updateMany({
    where: { id: job.id, status: JobStatus.dead, maxAttempts: job.maxAttempts },
    data: {
      status: JobStatus.queued,
      maxAttempts: job.maxAttempts + 1,
      priority: REVIVAL_PRIORITY,
      runAfter: now,
      completedAt: null,
    },
  });
  return count > 0;
}

/** How much of the original error the abandonment note carries. */
const ABANDON_NOTE_LIMIT = 1000;

/**
 * Close a job's budget and record why, leaving it `dead` for an operator.
 *
 * The original error is truncated rather than the whole note, so the marker and the cause survive
 * however long the error was — `scripts/requeue-jobs.ts --match` reads both ends of this string.
 *
 * `completedAt` is left where it is: it dates the death, `pruneFinishedJobs` collects the row on
 * `FAILED_JOB_TTL_MS`, and moving it would both falsify the record and postpone the collection.
 */
async function abandon(
  db: PrismaClient,
  job: BuriedJob,
  cause: DeathCause,
  reason: string,
): Promise<boolean> {
  const head = `${JOB_ABANDONED_MARKER}: ${cause} — ${reason}; last error: `;
  const note = head + (job.lastError ?? 'none recorded').slice(0, ABANDON_NOTE_LIMIT - head.length);

  const { count } = await db.ingestJob.updateMany({
    where: { id: job.id, status: JobStatus.dead, maxAttempts: job.maxAttempts },
    data: { maxAttempts: ABANDONED_MAX_ATTEMPTS, lastError: note },
  });
  return count > 0;
}

/** The revived keys as one log line, truncated the way every other key list in the queue is. */
export function describeRevived(revived: readonly string[]): string {
  return `${revived.length} buried job(s) given one more attempt: ${namedKeys(revived)}`;
}
