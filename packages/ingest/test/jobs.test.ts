import { describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import { AREA_PRIORITY, VIEWPORT_PRIORITY } from '../src/coverage';
import { NETWORK_PRIORITY } from '../src/network';
import { SPLIT_PRIORITY } from '../src/subdivide';
import {
  DEFAULT_MAX_ATTEMPTS,
  LEASE_EXPIRED_MARKER,
  LEASE_TIMEOUT_MS,
  RECLAIM_PRIORITY,
  claimJobs,
  completeJob,
  deferJob,
  drainJobs,
  enqueue,
  failJob,
  reclaimExpiredJobs,
  tileJobKey,
  trailEnrichJobKey,
} from '../src/jobs';
import type { ClaimedJob, Db, DrainResult } from '../src/jobs';

interface Recorded {
  updates: Array<{ id: string; data: Record<string, unknown> }>;
  updateManys: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  upserts: Array<Record<string, unknown>>;
  /** The last raw call's interpolated values. */
  rawValues: unknown[];
  /** Every raw call's values, in order. */
  rawCalls: unknown[][];
  /** Every raw call's SQL text, with its bound values left out. */
  rawSql: string[];
  /** What the lease sweep did to each `running` row it matched. */
  reaped: Array<{ id: string; attempts: number; status: JobStatus }>;
  /** The lease sweep's interpolated values. */
  reapValues: unknown[];
}

/** A row sitting in `running`, for the lease sweep to judge. */
interface RunningRow {
  id: string;
  lockedAt: Date;
  attempts: number;
  maxAttempts: number;
}

interface FakeOptions {
  /** Rows in `running`. The sweep's own cutoff decides which of them it takes. */
  running?: RunningRow[];
  /** Rows a fenced outcome write matches. 0 stands for a lease already reclaimed. */
  outcomeCount?: number;
}

/**
 * A Prisma stand-in covering exactly the calls this module makes. Enough to assert the
 * queue's decisions — reschedule vs bury, backoff, revival, ordering, the lease — without a
 * database.
 */
function fakeDb(
  claimable: ClaimedJob[] = [],
  options: FakeOptions = {},
): { db: Db; recorded: Recorded } {
  const recorded: Recorded = {
    updates: [],
    updateManys: [],
    upserts: [],
    rawValues: [],
    rawCalls: [],
    rawSql: [],
    reaped: [],
    reapValues: [],
  };
  const running = options.running ?? [];
  let claims = 0;
  const db = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      recorded.rawSql.push(sql);
      /*
       * The lease sweep, run out of its own interpolated parameters rather than a fixture: it
       * binds `now` then `cutoff`, and applying that cutoff and that retirement rule here is
       * what makes "expired is taken, fresh is not" an assertion about `reclaimExpiredJobs`
       * and not about the fake. Kept out of `rawCalls`, which the claim assertions index into.
       */
      if (sql.includes('RETURNING status')) {
        recorded.reapValues = values;
        const [, cutoff] = values.filter((v): v is Date => v instanceof Date);
        return running
          .filter((row) => row.lockedAt.getTime() < cutoff!.getTime())
          .map((row) => {
            const attempts = row.attempts + 1;
            const status = attempts >= row.maxAttempts ? JobStatus.dead : JobStatus.queued;
            recorded.reaped.push({ id: row.id, attempts, status });
            return { status };
          });
      }
      recorded.rawValues = values;
      recorded.rawCalls.push(values);
      claims += 1;
      // Only the first claim yields work. The second is the derived share, and handing it
      // the same rows would double-run them in every test that drains.
      return claims === 1 ? claimable : [];
    },
    ingestJob: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        recorded.updates.push({ id: args.where.id, data: args.data });
        return {};
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        recorded.updateManys.push({ where: args.where, data: args.data });
        // A fenced outcome write is keyed on the job's id; `enqueue`'s revival is not.
        if (typeof args.where.id === 'string') {
          const count = options.outcomeCount ?? 1;
          recorded.updates.push({ id: args.where.id, data: args.data });
          return { count };
        }
        return { count: 0 };
      },
      upsert: async (args: Record<string, unknown>) => {
        recorded.upserts.push(args);
        return {};
      },
    },
  } as unknown as Db;
  return { db, recorded };
}

/**
 * A `Prisma.sql` fragment, structurally. Matched by shape rather than `instanceof`:
 * `Prisma.Sql` is a type in the generated namespace, not a runtime constructor.
 */
interface SqlFragment {
  strings: readonly string[];
  values: readonly unknown[];
}

/**
 * The `AND …` fragment `claimJobs` splices into its `WHERE` clause. The real client flattens
 * nested fragments before the driver sees them; the fake above is an ordinary tagged template,
 * so asserting on the fragment proves the keys are bound parameters, not interpolated text.
 */
function scopeFragment(values: unknown[]): SqlFragment {
  const fragment = values.find(
    (v): v is SqlFragment =>
      typeof v === 'object' && v !== null && Array.isArray((v as SqlFragment).strings),
  );
  expect(fragment, 'claimJobs interpolated no scope fragment').toBeDefined();
  return fragment!;
}

/** That fragment's SQL text, with its bound values left out. */
function scopeSql(values: unknown[]): string {
  return scopeFragment(values).strings.join('?');
}

/** A value's fragment values, or nothing when it is not a fragment. */
function fragmentValues(value: unknown): readonly unknown[] {
  return typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as SqlFragment).strings)
    ? (value as SqlFragment).values
    : [];
}

/**
 * Every spliced fragment's SQL, joined. `claimJobs` splices two — the `dedupeKey` scope and
 * the kind scope — and `scopeFragment` returns only the first.
 */
function allScopeSql(values: unknown[]): string {
  return values
    .filter(
      (v): v is SqlFragment =>
        typeof v === 'object' && v !== null && Array.isArray((v as SqlFragment).strings),
    )
    .map((fragment) => fragment.strings.join('?'))
    .join(' ');
}

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: 'job-1',
    kind: JobKind.ingest_tile,
    dedupeKey: tileJobKey('033311323'),
    payload: { quadkey: '033311323' },
    attempts: 1,
    maxAttempts: 5,
    lockedAt: new Date('2026-01-01T11:00:00Z'),
    lockedBy: 'worker-a',
    ...overrides,
  };
}

/** A drain that did nothing, so each case names only the counts it is about. */
function drained(overrides: Partial<DrainResult> = {}): DrainResult {
  return {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    buried: 0,
    deferred: 0,
    lost: 0,
    derived: 0,
    requeued: 0,
    retired: 0,
    ...overrides,
  };
}

describe('job keys', () => {
  it('are stable and namespaced by kind', () => {
    expect(tileJobKey('033311323')).toBe('ingest_tile:033311323');
    expect(trailEnrichJobKey('abc')).toBe('enrich_trail:abc');
    // The same tile always produces the same key, which is what collapses twelve map requests
    // for one cold tile into one job.
    expect(tileJobKey('033311323')).toBe(tileJobKey('033311323'));
  });
});

describe('enqueue', () => {
  it('keys on the dedupe key and defaults the attempt budget', async () => {
    const { db, recorded } = fakeDb();
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: { quadkey: '0333' },
    });

    const args = recorded.upserts[0] as {
      where: { dedupeKey: string };
      create: Record<string, unknown>;
    };
    expect(args.where.dedupeKey).toBe('ingest_tile:0333');
    expect(args.create.maxAttempts).toBe(5);
    expect(args.create.priority).toBe(0);
  });

  it('hands a revived job the whole budget back, not the one the reconciler raised', async () => {
    /*
     * **The invariant the revival ladder rests on, from the other end.** `reconcileDeadJobs` keeps
     * its budget in `maxAttempts` — raising it one per revival and past `REVIVAL_CEILING` when it
     * gives up — precisely because `enqueue` clears `attempts` and that column therefore cannot
     * hold a durable count. A counter that only ever climbed would hand a fresh request nine
     * attempts instead of five and, once re-buried above the ceiling, would leave the row matching
     * no rung of that reconciler at all, with nothing reporting it. So the revive arm has to bring
     * it down, and this is the assertion that says so.
     */
    const { db, recorded } = fakeDb();
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: {},
    });

    expect(recorded.updateManys[0]?.data.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('honours a caller that asks for a budget of its own on the revive arm', async () => {
    const { db, recorded } = fakeDb();
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: {},
      maxAttempts: 2,
    });

    // The reset is to what this request asks for, not to a constant — the two arms of the upsert
    // must not disagree about the budget a new request gets.
    expect(recorded.updateManys[0]?.data.maxAttempts).toBe(2);
    expect((recorded.upserts[0] as { create: Record<string, unknown> }).create.maxAttempts).toBe(2);
  });

  it('does not reset an existing job when the same work is requested again', async () => {
    const { db, recorded } = fakeDb();
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: {},
      priority: 5,
    });

    const args = recorded.upserts[0] as { update: Record<string, unknown> };
    // `runAfter` untouched on collision, or a fresh page load clears a backoff. The upsert writes
    // nothing at all on collision: priority moves only through the guarded raise below.
    expect(args.update).not.toHaveProperty('runAfter');
    expect(args.update).not.toHaveProperty('priority');
    /*
     * `maxAttempts` least of all, and it is the one worth naming: it is a public `EnqueueInput`
     * field, so honouring it here reads like a courtesy. It would reset the revival budget of a
     * live job on every viewport poll, which is an unbounded retry loop for a poison tile.
     */
    expect(args.update).not.toHaveProperty('maxAttempts');
    expect(args.update).toEqual({});
  });

  it('raises priority only when the incoming band is higher', async () => {
    // A viewport asking again for a tile whose lease the reaper has just taken back is the
    // ordinary case, and `VIEWPORT_PRIORITY` sits below `RECLAIM_PRIORITY` — so an unconditional
    // write would demote the one row that has to reach the head of the queue.
    expect(VIEWPORT_PRIORITY).toBeLessThan(RECLAIM_PRIORITY);

    const { db, recorded } = fakeDb();
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: {},
      priority: VIEWPORT_PRIORITY,
    });

    const raise = recorded.updateManys.at(-1);
    expect(raise?.where).toEqual({
      dedupeKey: 'ingest_tile:0333',
      priority: { lt: VIEWPORT_PRIORITY },
    });
    expect(raise?.data).toEqual({ priority: VIEWPORT_PRIORITY });
  });

  it('revives a finished job so the same work can be requested again later', async () => {
    // A `dedupeKey` is forever, so without revival a tile that reached `done` could never be
    // re-ingested, and one that exhausted its attempts during an outage stayed `dead`.
    const { db, recorded } = fakeDb();
    const runAfter = new Date('2026-03-04T05:06:07Z');
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: {},
      runAfter,
    });

    const revive = recorded.updateManys[0];
    expect(revive).toBeDefined();
    expect(revive?.where.dedupeKey).toBe('ingest_tile:0333');
    // Only terminal rows. An in-flight job keeps its schedule and its attempt count.
    expect(revive?.where.status).toEqual({
      in: [JobStatus.done, JobStatus.failed, JobStatus.dead],
    });
    expect(revive?.data.status).toBe(JobStatus.queued);
    expect(revive?.data.attempts).toBe(0);
    // Reset with `attempts`, and for the same reason — see the budget test above.
    expect(revive?.data.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(revive?.data.runAfter).toBe(runAfter);
    expect(revive?.data.completedAt).toBeNull();
    expect(revive?.data.lockedAt).toBeNull();
    // Kept: until this attempt writes its own outcome it is the row's only diagnostic.
    expect(revive?.data).not.toHaveProperty('lastError');
  });

  it('returns a revived job to the band its request asks for', async () => {
    /*
     * The reaper raises an expired lease to `RECLAIM_PRIORITY`, and the retirement branch leaves
     * that elevation on the buried row. Reviving without writing `priority` left it there for the
     * row's whole remaining life: the raise below is guarded on `priority < incoming`, so a
     * viewport enqueue at 5 is a no-op against 6, and nothing else in the estate lowers it. The
     * row then outranked ordinary work until `FAILED_JOB_TTL_MS` collected it, thirty days on.
     */
    const { db, recorded } = fakeDb();
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: {},
      priority: VIEWPORT_PRIORITY,
    });

    const revive = recorded.updateManys[0];
    expect(revive?.data.priority).toBe(VIEWPORT_PRIORITY);
    expect(VIEWPORT_PRIORITY).toBeLessThan(RECLAIM_PRIORITY);
  });

  it('defaults a revived job to the base band when the request names none', async () => {
    const { db, recorded } = fakeDb();
    await enqueue(db, { kind: JobKind.ingest_tile, dedupeKey: tileJobKey('0333'), payload: {} });

    expect(recorded.updateManys[0]?.data.priority).toBe(0);
  });
});

describe('claimJobs', () => {
  it('claims only queued work that is due', async () => {
    const { db, recorded } = fakeDb();
    const now = new Date('2026-01-01T12:00:00Z');
    await claimJobs(db, 'worker-a', 4, now);

    expect(recorded.rawValues).toContain('worker-a');
    expect(recorded.rawValues).toContain(4);
    // Expired leases used to be a second arm of this predicate, and that put reclaiming a dead
    // worker's job behind `ORDER BY priority DESC … LIMIT`. `reclaimExpiredJobs` owns it now.
    const sql = recorded.rawSql.at(-1)!;
    expect(sql).toContain("status = 'queued'");
    expect(sql).not.toContain("status = 'running'");
  });

  it('hands the lease it stamped back to the worker', async () => {
    // The fence every outcome is written under — see `writeOutcome`.
    const { db, recorded } = fakeDb();
    await claimJobs(db, 'worker-a', 4, new Date());

    const sql = recorded.rawSql.at(-1)!;
    expect(sql).toContain('"lockedAt"');
    expect(sql).toContain('"lockedBy"');
  });

  it('claims from the whole table when no scope is given', async () => {
    const { db, recorded } = fakeDb();
    await claimJobs(db, 'cron', 4, new Date());

    // `Prisma.empty` — no `AND` is spliced in at all, so the claim orders the entire table.
    expect(scopeSql(recorded.rawValues)).toBe('');
  });

  it('narrows the claim to the requested keys', async () => {
    const { db, recorded } = fakeDb();
    const keys = [tileJobKey('021231030'), tileJobKey('021231031')];
    await claimJobs(db, 'inline', 4, new Date(), keys);

    expect(scopeSql(recorded.rawValues)).toContain('"dedupeKey" IN');
    // Interpolated as bound parameters, never as SQL text.
    expect(scopeFragment(recorded.rawValues).values).toEqual(keys);
  });

  /**
   * `IN ()` is not valid SQL, so the tempting shortcut — treat empty like `undefined` — is
   * exactly backwards: a caller with nothing to ask for would claim the head of the table,
   * silently, because the drain then succeeds and does real work nobody asked for.
   */
  it('claims nothing when the scope is empty rather than everything', async () => {
    const { db, recorded } = fakeDb();
    await claimJobs(db, 'inline', 4, new Date(), []);

    expect(scopeSql(recorded.rawValues)).toContain('false');
    expect(scopeSql(recorded.rawValues)).not.toContain('dedupeKey');
  });

  it('narrows the claim to specific kinds when asked', async () => {
    const { db, recorded } = fakeDb();
    await claimJobs(db, 'cron', 2, new Date(), undefined, [
      JobKind.enrich_trail,
      JobKind.ingest_route,
    ]);

    const sql = allScopeSql(recorded.rawValues);
    expect(sql).toContain('kind = ANY(');
    // The cast belongs on the parameter: on the column it silently drops
    // `@@index([kind, status])`, which this queue's hot path depends on.
    expect(sql).toContain('::"JobKind"[]');
    expect(sql).not.toContain('kind::text');
    expect(recorded.rawValues.flatMap(fragmentValues)).toEqual([
      [JobKind.enrich_trail, JobKind.ingest_route],
    ]);
  });

  it('claims nothing when the kind list is empty rather than everything', async () => {
    const { db, recorded } = fakeDb();
    await claimJobs(db, 'cron', 2, new Date(), undefined, []);

    expect(allScopeSql(recorded.rawValues)).toContain('false');
    expect(allScopeSql(recorded.rawValues)).not.toContain('kind = ANY(');
  });
});

/**
 * The lease. Nineteen production jobs sat in `running` for seventy-five hours with `attempts=1`
 * and no `lastError`, because the only thing that reclaimed an expired lock did so inside
 * `claimJobs`' `ORDER BY priority DESC … LIMIT 4`, behind a five-figure backlog.
 */
describe('reclaimExpiredJobs', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const stale = new Date(now.getTime() - LEASE_TIMEOUT_MS - 60_000);
  const fresh = new Date(now.getTime() - 60_000);

  /** The reap statement's SQL, with its indentation flattened so it can be matched literally. */
  function reapSql(recorded: Recorded): string {
    const found = recorded.rawSql.find((sql) => sql.includes('RETURNING status'));
    if (!found) throw new Error('the lease sweep did not run');
    return found.replace(/\s+/g, ' ');
  }

  it('outranks every band enqueue assigns, or the row it freed stays behind the backlog', () => {
    /*
     * `priority DESC` leads both `runPump`'s order and `claimJobs`, and returning a row to
     * `queued` at the priority it had puts it at the tail of its own band. A band added above
     * this constant would falsify the recovery bound `classifyDisposition` completes a Service
     * Bus message on, and nothing else in the estate would notice.
     */
    for (const band of [VIEWPORT_PRIORITY, SPLIT_PRIORITY, NETWORK_PRIORITY, AREA_PRIORITY]) {
      expect(RECLAIM_PRIORITY).toBeGreaterThan(band);
    }
  });

  it('raises a requeued lease to the head of the queue, and never lowers a higher one', async () => {
    const { db, recorded } = fakeDb([], {
      running: [{ id: 'stuck', lockedAt: stale, attempts: 1, maxAttempts: 5 }],
    });

    await reclaimExpiredJobs(db, now);

    // Bound rather than inlined, so the statement carries the constant the pump's order is
    // asserted against rather than a copy of its value. The elevation sits inside the retirement
    // test, so a row out of attempts keeps the priority it had — the band exists to reach a
    // worker, and a buried row is not going to one.
    expect(recorded.reapValues).toContain(RECLAIM_PRIORITY);
    expect(reapSql(recorded)).toContain(
      'priority = CASE WHEN attempts + 1 >= "maxAttempts" ' +
        'THEN priority ELSE GREATEST(priority, ?::int) END',
    );
  });

  it('takes back a job locked beyond the timeout and spends an attempt on it', async () => {
    const { db, recorded } = fakeDb([], {
      running: [{ id: 'stuck', lockedAt: stale, attempts: 1, maxAttempts: 5 }],
    });

    const result = await reclaimExpiredJobs(db, now);

    expect(result.requeued).toBe(1);
    expect(result.retired).toBe(0);
    // Back to `queued` with the attempt counted — a job that keeps killing its worker has to
    // move towards its budget, or the sweep that recovers it is also the loop that repeats it.
    expect(recorded.reaped).toEqual([{ id: 'stuck', attempts: 2, status: JobStatus.queued }]);
  });

  it('names the lease it took back, so the alert has something to match on', async () => {
    /*
     * The signal that closes the killed-handler gap. This reaper is the only participant that
     * observes the death: by the time a redelivered message is classified, the reclaim below has
     * already returned the row to `queued`, so the delivery sees a healthy queue.
     */
    const { db } = fakeDb([], {
      running: [{ id: 'stuck', lockedAt: stale, attempts: 1, maxAttempts: 5 }],
    });
    const lines: string[] = [];

    const result = await reclaimExpiredJobs(db, now, LEASE_TIMEOUT_MS, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(LEASE_EXPIRED_MARKER);
    expect(result.reclaimed).toHaveLength(1);
  });

  it('says nothing when no lease had expired, so the alert is not a light left on', async () => {
    const { db } = fakeDb([], {
      running: [{ id: 'working', lockedAt: fresh, attempts: 1, maxAttempts: 5 }],
    });
    const lines: string[] = [];

    await reclaimExpiredJobs(db, now, LEASE_TIMEOUT_MS, (line) => lines.push(line));

    expect(lines).toEqual([]);
  });

  it('leaves a freshly locked job alone', async () => {
    // The other half of the same decision: a lease that has not expired belongs to a worker
    // that is still running, and taking it would run the tile twice.
    const { db, recorded } = fakeDb([], {
      running: [{ id: 'working', lockedAt: fresh, attempts: 1, maxAttempts: 5 }],
    });

    const result = await reclaimExpiredJobs(db, now);

    expect(result.requeued).toBe(0);
    expect(result.retired).toBe(0);
    expect(recorded.reaped).toEqual([]);
  });

  it('retires a job that has run out of attempts rather than requeueing it forever', async () => {
    // A job whose handler takes the worker down with it never reaches `failJob`, so without
    // this the sweep would hand it back every lease period for as long as the table exists.
    const { db, recorded } = fakeDb([], {
      running: [
        { id: 'poison', lockedAt: stale, attempts: 4, maxAttempts: 5 },
        { id: 'ordinary', lockedAt: stale, attempts: 1, maxAttempts: 5 },
      ],
    });

    const result = await reclaimExpiredJobs(db, now);

    expect(result.requeued).toBe(1);
    expect(result.retired).toBe(1);
    expect(recorded.reaped[0]).toEqual({ id: 'poison', attempts: 5, status: JobStatus.dead });
  });

  it('says why on the row, and does not push the schedule out', async () => {
    const { db, recorded } = fakeDb([], {
      running: [{ id: 'stuck', lockedAt: stale, attempts: 1, maxAttempts: 5 }],
    });

    await reclaimExpiredJobs(db, now);

    const sql = recorded.rawSql.at(-1)!;
    // These rows carried a null `lastError` for three days and nothing on them said what
    // happened; the lease itself has already spaced the retry, so `runAfter` stays put.
    expect(recorded.reapValues).toContainEqual(
      expect.stringContaining('lease expired after 12 min'),
    );
    expect(recorded.reapValues).toContainEqual(new Date(now.getTime() - LEASE_TIMEOUT_MS));
    expect(sql).toContain('"lastError"');
    expect(sql).not.toContain('"runAfter"');
    expect(sql).toContain("status = 'running'");
  });
});

/**
 * The other half of the lease: a worker that overran its own and came back to write an outcome
 * for a job somebody else now owns.
 */
describe('the outcome fence', () => {
  it('records an outcome while the lease is held', async () => {
    const { db, recorded } = fakeDb();

    await expect(completeJob(db, job(), new Date())).resolves.toBe(true);

    // Conditional on the lease *and* on the job still being in it, not on the id alone.
    const fence = recorded.updateManys.at(-1)!.where;
    expect(fence).toEqual({
      id: 'job-1',
      status: JobStatus.running,
      lockedBy: 'worker-a',
      lockedAt: job().lockedAt,
    });
  });

  it("drops a late worker's outcome rather than overwriting the new owner", async () => {
    // `outcomeCount: 0` is the row no longer carrying this lease. `completeJob` would only
    // write a duplicate `done`, but `failJob` would requeue finished work *and* null a lock a
    // live worker is holding, which is how two workers end up on one job.
    const { db } = fakeDb([], { outcomeCount: 0 });

    await expect(completeJob(db, job(), new Date())).resolves.toBe(false);
    await expect(failJob(db, job(), new Error('too late'), new Date())).resolves.toBe(false);
  });

  it('counts a lost lease apart from a success, so the timeout can be tuned', async () => {
    const { db } = fakeDb([job()], { outcomeCount: 0 });

    const result = await drainJobs({ [JobKind.ingest_tile]: async () => {} }, { db });

    expect(result.succeeded).toBe(0);
    expect(result.lost).toBe(1);
    expect(result.claimed).toBe(1);
  });
});

/**
 * `failJob` reschedules below `maxAttempts` and buries only the last attempt, and the row cannot be
 * read back afterwards to tell which happened. Counting them apart is what lets a burial page on
 * `switchback-ingest-ground-lost` while a retry stays on `switchback-ingest-drain-degraded`.
 */
describe('a burial, counted apart from a retry', () => {
  const throwing = { [JobKind.ingest_tile]: async () => Promise.reject(new Error('handler')) };

  it('leaves a job with an attempt left out of the buried count', async () => {
    const { db, recorded } = fakeDb([job({ attempts: 1, maxAttempts: 5 })]);

    const result = await drainJobs(throwing, { db });

    expect(result.failed).toBe(1);
    expect(result.buried).toBe(0);
    // The counter and the row have to agree, or the alert describes something that did not happen.
    expect(recorded.updates.at(-1)?.data.status).toBe(JobStatus.queued);
  });

  it('counts the attempt that exhausts the budget, which is the one nothing retries', async () => {
    const { db, recorded } = fakeDb([job({ attempts: 5, maxAttempts: 5 })]);

    const result = await drainJobs(throwing, { db });

    expect(result.failed).toBe(1);
    expect(result.buried).toBe(1);
    expect(recorded.updates.at(-1)?.data.status).toBe(JobStatus.dead);
  });

  it('does not count a failure the fence dropped, since that row belongs to another worker', async () => {
    // `lost`, not `buried`: the outcome was never written, so nothing was buried.
    const { db } = fakeDb([job({ attempts: 5, maxAttempts: 5 })], { outcomeCount: 0 });

    const result = await drainJobs(throwing, { db });

    expect(result.lost).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.buried).toBe(0);
  });
});

/**
 * `INGEST_MAX_DRAINERS` is enforced by `drainSlotGate` counting `distinct "lockedBy"` over
 * `running` rows — a reading that exists only while something is mid-drain, and eight samples over
 * seventy seconds of production caught zero. Leaving the lease pair on the row after the outcome
 * is what makes the achieved concurrency recoverable from finished work instead: `lockedAt` and
 * `completedAt` bound one drain, so overlapping intervals answer it.
 *
 * Nothing is nulled on the way out, so `status` has to be the thing that releases the lease.
 * Both halves are asserted here — a fence that dropped `status` while the writes stopped nulling
 * would let a reclaimed-then-requeued job accept its old worker's outcome.
 */
describe('which process ran a job', () => {
  it.each([
    ['completeJob', (db: Db) => completeJob(db, job(), new Date())],
    ['failJob', (db: Db) => failJob(db, job(), new Error('nope'), new Date())],
    ['deferJob', (db: Db) => deferJob(db, { ...job(), attempts: 1 }, 'wrong build', new Date())],
  ])('survives %s', async (_name, write) => {
    const { db, recorded } = fakeDb();

    await write(db);

    const write_ = recorded.updateManys.at(-1)!;
    expect(write_.data).not.toHaveProperty('lockedBy');
    expect(write_.data).not.toHaveProperty('lockedAt');
    // The release, in place of the nulls.
    expect(write_.where.status).toBe(JobStatus.running);
  });

  it('survives the lease sweep that takes a dead worker back', async () => {
    const { db, recorded } = fakeDb([], {
      running: [{ id: 'job-9', lockedAt: new Date(0), attempts: 1, maxAttempts: 5 }],
    });

    await reclaimExpiredJobs(db, new Date(LEASE_TIMEOUT_MS * 2));

    const sweep = recorded.rawSql.find((sql) => sql.includes('RETURNING status'))!;
    // Scoped to the assignments: the sweep *reads* `lockedBy` back to say who died, and must
    // not write over either column — they are the only record of which process held the lease.
    const assignments = sweep.slice(sweep.indexOf('SET'), sweep.indexOf('WHERE'));
    expect(assignments).not.toContain('"lockedBy"');
    expect(assignments).not.toContain('"lockedAt"');
    // What releases it instead — the sweep writes `queued` or `dead` over `running`.
    expect(sweep).toContain("status = 'running'");
  });
});

/**
 * The starvation this share exists to break: `claimJobs` orders `priority DESC` and derived
 * work sits at `-10`, while both inline kicks scope to the tile keys they just queued and so
 * cannot reach a derived row at all.
 */
describe('the derived share', () => {
  it('claims derived work in a second, kind-scoped pass', async () => {
    const { db, recorded } = fakeDb();

    await drainJobs({}, { db, dedupeKeys: [tileJobKey('021231030')], derivedLimit: 2 });

    expect(recorded.rawCalls).toHaveLength(2);
    // The first claim is the caller's own work, scoped by key and unrestricted by kind.
    expect(allScopeSql(recorded.rawCalls[0]!)).toContain('"dedupeKey" IN');
    expect(allScopeSql(recorded.rawCalls[0]!)).not.toContain('kind = ANY(');
    // The second is the reservation: kind-scoped, and deliberately *not* key-scoped.
    expect(allScopeSql(recorded.rawCalls[1]!)).toContain('kind = ANY(');
    expect(allScopeSql(recorded.rawCalls[1]!)).not.toContain('"dedupeKey" IN');
    expect(recorded.rawCalls[1]!).toContain(2);
  });

  it('reaches derived work even when the caller scoped itself to nothing', async () => {
    // The share does not ride on the primary claim finding anything.
    const { db, recorded } = fakeDb();

    await drainJobs({}, { db, dedupeKeys: [], derivedLimit: 2 });

    expect(recorded.rawCalls).toHaveLength(2);
    expect(allScopeSql(recorded.rawCalls[1]!)).toContain('kind = ANY(');
  });

  it('asks for nothing extra when the share is zero', async () => {
    const { db, recorded } = fakeDb();

    await drainJobs({}, { db, derivedLimit: 0 });

    expect(recorded.rawCalls).toHaveLength(1);
  });

  it('reports how much of the batch came from the share', async () => {
    const { db } = fakeDb([job()]);

    const result = await drainJobs({ [JobKind.ingest_tile]: async () => {} }, { db });

    // Zero rather than absent: the fake yields rows on the first claim only, so this pins that
    // the count reports the second claim's haul and not the batch's.
    expect(result.derived).toBe(0);
    expect(result.claimed).toBe(1);
  });

  it('drains the primary batch even when the derived claim fails', async () => {
    // Ordering is the argument: by the time the derived pass runs, the primary batch is
    // already `running` with a lock stamped, so letting the rejection out would strand it for
    // `LEASE_TIMEOUT_MS`. The thrown message is the shape a bad enum cast would take.
    const { db, recorded } = fakeDb([job()]);
    const raw = (db as unknown as { $queryRaw: (...args: unknown[]) => Promise<unknown> })
      .$queryRaw;
    let claims = 0;
    (db as unknown as { $queryRaw: (...args: unknown[]) => Promise<unknown> }).$queryRaw = async (
      ...args: unknown[]
    ) => {
      // Counted over claims only — the lease sweep runs first and is not one of them.
      const sql = (args[0] as TemplateStringsArray).join('?');
      if (!sql.includes('RETURNING status')) claims += 1;
      if (claims === 2) throw new Error('operator does not exist: "JobKind" = text');
      return raw(...args);
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const ran: string[] = [];
    const result = await drainJobs(
      {
        [JobKind.ingest_tile]: async (claimed: ClaimedJob) => {
          ran.push(claimed.id);
        },
      },
      { db, derivedLimit: 2 },
    );

    expect(ran).toEqual(['job-1']);
    expect(result).toEqual(drained({ claimed: 1, succeeded: 1 }));
    // Completed, not left at `running` for the lock timeout to pick up.
    expect(recorded.updates.at(-1)?.data.status).toBe(JobStatus.done);
    // And loudly: a share that has silently stopped running is a backlog nobody is watching.
    expect(errors).toHaveBeenCalled();
  });
});

describe('failJob', () => {
  it('reschedules with a growing backoff while attempts remain', async () => {
    const now = new Date('2026-01-01T12:00:00Z');

    const first = fakeDb();
    await failJob(first.db, job({ attempts: 1 }), new Error('overpass 504'), now);
    expect(first.recorded.updates[0]!.data.status).toBe(JobStatus.queued);
    expect((first.recorded.updates[0]!.data.runAfter as Date).getTime()).toBe(
      now.getTime() + 30_000,
    );

    const third = fakeDb();
    await failJob(third.db, job({ attempts: 3 }), new Error('overpass 504'), now);
    expect((third.recorded.updates[0]!.data.runAfter as Date).getTime()).toBe(
      now.getTime() + 10 * 60_000,
    );
  });

  it('buries rather than deletes a job that has exhausted its attempts', async () => {
    const { db, recorded } = fakeDb();
    await failJob(db, job({ attempts: 5, maxAttempts: 5 }), new Error('gone'), new Date());

    // Dead, not deleted: the row names a tile Overpass cannot serve, which is the most
    // informative thing in the table.
    expect(recorded.updates[0]!.data.status).toBe(JobStatus.dead);
    expect(recorded.updates[0]!.data.runAfter).toBeUndefined();
    expect(recorded.updates[0]!.data.lastError).toBe('gone');
  });

  it('bounds the stored error so one stack trace cannot bloat the table', async () => {
    const { db, recorded } = fakeDb();
    await failJob(db, job(), new Error('x'.repeat(5000)), new Date());
    expect(recorded.updates[0]!.data.lastError).toHaveLength(1000);
  });

  it('records a non-Error throw rather than losing it', async () => {
    const { db, recorded } = fakeDb();
    await failJob(db, job(), 'string failure', new Date());
    expect(recorded.updates[0]!.data.lastError).toBe('string failure');
  });
});

describe('drainJobs', () => {
  it('completes the jobs whose handler succeeds', async () => {
    const { db, recorded } = fakeDb([job({ id: 'a' }), job({ id: 'b' })]);
    const handled: string[] = [];

    const result = await drainJobs(
      { [JobKind.ingest_tile]: async (j) => void handled.push(j.id) },
      { db, now: () => new Date('2026-01-01T12:00:00Z') },
    );

    expect(handled).toEqual(['a', 'b']);
    expect(result).toEqual(drained({ claimed: 2, succeeded: 2 }));
    expect(recorded.updates.map((u) => u.data.status)).toEqual([JobStatus.done, JobStatus.done]);
  });

  it('runs jobs one at a time, because the Overpass client is the real bottleneck', async () => {
    const { db } = fakeDb([job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]);
    let inFlight = 0;
    let peak = 0;

    await drainJobs(
      {
        [JobKind.ingest_tile]: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight -= 1;
        },
      },
      { db },
    );

    // Four handlers at once would hold four database connections while three of them queue
    // inside the Overpass client anyway.
    expect(peak).toBe(1);
  });

  it('isolates a failing job from the rest of the batch', async () => {
    const { db, recorded } = fakeDb([job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]);

    const result = await drainJobs(
      {
        [JobKind.ingest_tile]: async (j) => {
          if (j.id === 'b') throw new Error('broken geometry');
        },
      },
      { db },
    );

    expect(result).toEqual(drained({ claimed: 3, succeeded: 2, failed: 1 }));
    expect(recorded.updates.map((u) => u.data.status)).toEqual([
      JobStatus.done,
      JobStatus.queued,
      JobStatus.done,
    ]);
  });

  it('hands an unhandled kind back without spending an attempt', async () => {
    // A newer client enqueued work this build has no handler for. That is a deploy
    // ordering problem which resolves itself in a minute, so it must not count against
    // the job: five cron ticks at one attempt each would mark it `dead` inside three
    // minutes, and it would stay dead after the deploy that could have run it landed.
    const { db, recorded } = fakeDb([job({ id: 'a', kind: JobKind.enrich_trail, attempts: 1 })]);

    const result = await drainJobs({}, { db, now: () => new Date('2026-01-01T12:00:00Z') });

    expect(result).toEqual(drained({ claimed: 1, deferred: 1 }));
    const update = recorded.updates[0]!;
    expect(update.data.status).toBe(JobStatus.queued);
    expect(update.data.lastError).toMatch(/no handler registered/);
    // `claimJobs` already counted this attempt; deferring gives it back.
    expect(update.data.attempts).toBe(0);
    expect(update.data.runAfter).toEqual(new Date('2026-01-01T12:05:00Z'));
  });

  it('never lets a deferred job go below zero attempts', async () => {
    // Defensive: a claim always increments first, so `attempts` is at least 1 here in
    // practice. A negative count would still be a lie the whole table carries.
    const { db, recorded } = fakeDb([job({ id: 'a', kind: JobKind.enrich_trail, attempts: 0 })]);

    await drainJobs({}, { db });

    expect(recorded.updates[0]!.data.attempts).toBe(0);
  });

  it('reports an empty drain without touching anything', async () => {
    const { db, recorded } = fakeDb([]);
    const result = await drainJobs({ [JobKind.ingest_tile]: async () => {} }, { db });
    expect(result).toEqual(drained());
    expect(recorded.updates).toHaveLength(0);
  });
});
