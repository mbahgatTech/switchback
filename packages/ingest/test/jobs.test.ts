import { describe, expect, it } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import {
  LOCK_TIMEOUT_MS,
  claimJobs,
  drainJobs,
  enqueue,
  failJob,
  tileJobKey,
  trailEnrichJobKey,
} from '../src/jobs';
import type { ClaimedJob, Db } from '../src/jobs';

interface Recorded {
  updates: Array<{ id: string; data: Record<string, unknown> }>;
  updateManys: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  upserts: Array<Record<string, unknown>>;
  rawValues: unknown[];
}

/**
 * A Prisma stand-in covering exactly the calls this module makes. Enough to assert the
 * queue's decisions — reschedule vs bury, backoff, revival, ordering — without a database.
 */
function fakeDb(claimable: ClaimedJob[] = []): { db: Db; recorded: Recorded } {
  const recorded: Recorded = { updates: [], updateManys: [], upserts: [], rawValues: [] };
  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.rawValues = values;
      return claimable;
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
 * A `Prisma.sql` fragment, structurally.
 *
 * Matched by shape rather than `instanceof`: `Prisma.Sql` is a type in the generated
 * namespace, not a constructor at runtime, so there is nothing to test against. The pair of
 * arrays is the whole contract anyway — `strings` is the SQL either side of each hole and
 * `values` is what fills them.
 */
interface SqlFragment {
  strings: readonly string[];
  values: readonly unknown[];
}

/**
 * The `AND …` fragment `claimJobs` splices into its `WHERE` clause.
 *
 * The real client flattens nested fragments into one statement before it reaches the
 * driver; the fake above is an ordinary tagged template, so the fragment arrives intact as
 * a value and can be inspected directly. That is the point — asserting on the fragment
 * proves the keys are bound parameters rather than interpolated text.
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

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: 'job-1',
    kind: JobKind.ingest_tile,
    dedupeKey: tileJobKey('033311323'),
    payload: { quadkey: '033311323' },
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

describe('job keys', () => {
  it('are stable and namespaced by kind', () => {
    expect(tileJobKey('033311323')).toBe('ingest_tile:033311323');
    expect(trailEnrichJobKey('abc')).toBe('enrich_trail:abc');
    // The same tile always produces the same key — that is what makes twelve map requests
    // for one cold tile collapse into one job.
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

  it('does not reset an existing job when the same work is requested again', async () => {
    const { db, recorded } = fakeDb();
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey('0333'),
      payload: {},
      priority: 5,
    });

    const args = recorded.upserts[0] as { update: Record<string, unknown> };
    // A job that has already backed off twice must not have its backoff cleared by a fresh
    // page load — so `runAfter` is untouched on collision. Priority may rise, because
    // somebody is now actively waiting on the tile.
    expect(args.update).not.toHaveProperty('runAfter');
    expect(args.update.priority).toBe(5);
  });

  it('revives a finished job so the same work can be requested again later', async () => {
    // The regression this pins down: a `dedupeKey` is forever, so without a revival step a
    // tile that reached `done` could never be re-ingested — not by the thirty-day
    // staleness refresh, not by a retry after a fix, not by a user staring at a viewport
    // that never fills. And a tile that exhausted its attempts during an upstream outage
    // stayed `dead` for the life of the database.
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
    expect(revive?.data.runAfter).toBe(runAfter);
    expect(revive?.data.completedAt).toBeNull();
    expect(revive?.data.lockedAt).toBeNull();
    // Kept: until this attempt writes its own outcome it is the row's only diagnostic.
    expect(revive?.data).not.toHaveProperty('lastError');
  });
});

describe('claimJobs', () => {
  it('treats a lock older than the timeout as abandoned', async () => {
    const { db, recorded } = fakeDb();
    const now = new Date('2026-01-01T12:00:00Z');
    await claimJobs(db, 'worker-a', 4, now);

    // now, workerId, now, lockCutoff, limit — the cutoff is what recovers a worker that
    // died holding the lock.
    const cutoff = recorded.rawValues.find(
      (v): v is Date => v instanceof Date && v.getTime() !== now.getTime(),
    );
    expect(cutoff!.getTime()).toBe(now.getTime() - LOCK_TIMEOUT_MS);
    expect(recorded.rawValues).toContain('worker-a');
    expect(recorded.rawValues).toContain(4);
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
   * The case that turns a scoped claim into an unscoped one if it is missed.
   *
   * `IN ()` is not valid SQL, so an empty list cannot be expressed the obvious way, and the
   * tempting shortcut — treat empty like `undefined` — is exactly backwards: a caller with
   * nothing to ask for would claim whatever happened to be at the head of the table. That is
   * silent, because the drain succeeds and does real work; it is just never the work anybody
   * asked for.
   */
  it('claims nothing when the scope is empty rather than everything', async () => {
    const { db, recorded } = fakeDb();
    await claimJobs(db, 'inline', 4, new Date(), []);

    expect(scopeSql(recorded.rawValues)).toContain('false');
    expect(scopeSql(recorded.rawValues)).not.toContain('dedupeKey');
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
    expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0, deferred: 0 });
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

    expect(result).toEqual({ claimed: 3, succeeded: 2, failed: 1, deferred: 0 });
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

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 0, deferred: 1 });
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
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0, deferred: 0 });
    expect(recorded.updates).toHaveLength(0);
  });
});
