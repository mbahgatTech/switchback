import { describe, expect, it } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  ABANDONED_MAX_ATTEMPTS,
  CAUSE_RULES,
  JOB_ABANDONED_MARKER,
  REVIVAL_CEILING,
  REVIVAL_DELAYS_MS,
  REVIVAL_OUTSTANDING_MAX,
  REVIVAL_PRIORITY,
  classifyDeath,
  reconcileDeadJobs,
} from '../src/dead-jobs';
import { DEFAULT_MAX_ATTEMPTS, LEASE_EXPIRED_REASON_PREFIX, tileJobKey } from '../src/jobs';
import { VIEWPORT_PRIORITY } from '../src/coverage';
import { SPLIT_CHILD_ATTEMPT_CAP } from '../src/subdivide';
import { IngestDeadlineError } from '../src/deadline';
import { OverpassUnavailableError, overpassStatusText } from '../src/overpass';

const NOW = new Date('2026-08-29T12:00:00.000Z');

/** Long enough to clear the last rung, so a fixture is due whichever rung it is on. */
const LONG_AGO = new Date(NOW.getTime() - (REVIVAL_DELAYS_MS.at(-1) ?? 0) - 1);

/** One `ingest_jobs` row, in the columns the reconciler reads and writes. */
interface JobRow {
  id: string;
  kind: JobKind;
  dedupeKey: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  completedAt: Date | null;
  runAfter: Date;
}

/** One `ingest_tiles` row, in the two columns the split-child cap is read from. */
interface TileRow {
  quadkey: string;
  attempts: number;
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    kind: JobKind.ingest_tile,
    dedupeKey: tileJobKey('021301201'),
    status: JobStatus.dead,
    priority: VIEWPORT_PRIORITY,
    attempts: DEFAULT_MAX_ATTEMPTS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    lastError: `${LEASE_EXPIRED_REASON_PREFIX} 12 min with no outcome`,
    completedAt: LONG_AGO,
    runAfter: LONG_AGO,
    ...overrides,
  };
}

interface Clause {
  maxAttempts?: number | { gte?: number; gt?: number };
  completedAt?: { lt: Date };
}

interface CountWhere {
  kind?: { in: JobKind[] };
  status?: { in: JobStatus[] };
  maxAttempts?: { gt?: number };
}

/**
 * A Prisma stand-in that evaluates the `where` it is handed rather than replaying a fixed answer,
 * so a predicate the code stops building is a red test rather than an unchanged one. `updateMany`
 * applies `data`, which is what lets the assertions below be about the row's resulting state.
 */
/**
 * Which defence to disable *in the double*, so a test can prove the other one holds on its own.
 *
 * The invariant that a live job is never touched is defended twice — by the select predicate and
 * by the update fence — so mutating either in the source leaves every test green and the coverage
 * looks better than it is. Weakening one here is how each is shown to be load-bearing.
 */
interface Weaken {
  /** `findMany` ignores `status`, as it would if the code stopped narrowing to `dead`. */
  select?: boolean;
  /** `updateMany` matches on `id` alone, as it would if the code stopped fencing. */
  fence?: boolean;
}

function fakeDb(rows: JobRow[], tiles: TileRow[] = [], weaken: Weaken = {}): PrismaClient {
  const meetsBudget = (row: JobRow, want: Clause['maxAttempts']): boolean => {
    if (want === undefined) return true;
    if (typeof want === 'number') return row.maxAttempts === want;
    if (want.gte !== undefined) return row.maxAttempts >= want.gte;
    return want.gt === undefined || row.maxAttempts > want.gt;
  };

  const matches = (row: JobRow, clause: Clause): boolean =>
    meetsBudget(row, clause.maxAttempts) &&
    (clause.completedAt === undefined ||
      (row.completedAt !== null && row.completedAt < clause.completedAt.lt));

  return {
    ingestJob: {
      // `status` and `OR` are both optional here, for the reason `updateMany`'s fields are: a
      // clause the code stops building must make this double match *more*, so the test written for
      // that predicate goes red. Requiring them would make a dropped clause select nothing, which
      // reds a scatter of unrelated tests for the wrong reason and leaves the right one green.
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: { status?: JobStatus; OR?: Clause[]; maxAttempts?: number };
        orderBy?: { completedAt: 'asc' | 'desc' };
        take?: number;
      }) => {
        const found = rows
          .filter(
            (row) =>
              (weaken.select === true ||
                where.status === undefined ||
                row.status === where.status) &&
              meetsBudget(row, where.maxAttempts) &&
              (where.OR === undefined || where.OR.some((clause) => matches(row, clause))),
          )
          // Copies, as `select` returns: the fence below is only meaningful if a caller's reading
          // can go stale, and handing back live objects would hide that.
          .map((row) => ({ ...row }));

        /*
         * Honoured, because both head-of-line findings turn on it: a window filled by rows the
         * pass cannot act on starves the rows it can, and which rows fill it is decided here. A
         * double that ignored the sort could not tell a wedged window from a working one.
         */
        if (orderBy !== undefined) {
          const direction = orderBy.completedAt === 'desc' ? -1 : 1;
          found.sort(
            (a, b) =>
              direction * ((a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0)),
          );
        }
        return take === undefined ? found : found.slice(0, take);
      },
      count: async ({ where }: { where: CountWhere }) =>
        rows.filter(
          (row) =>
            (where.kind === undefined || where.kind.in.includes(row.kind)) &&
            (where.status === undefined || where.status.in.includes(row.status)) &&
            meetsBudget(row, where.maxAttempts),
        ).length,
      // Every field of the `where` is optional here, so dropping one from the fence is a row the
      // update starts matching rather than a clause the fake quietly fails.
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: string; status?: JobStatus; maxAttempts?: number };
        data: Partial<JobRow>;
      }) => {
        const row = rows.find(
          (candidate) =>
            (where.id === undefined || candidate.id === where.id) &&
            (weaken.fence === true ||
              ((where.status === undefined || candidate.status === where.status) &&
                (where.maxAttempts === undefined || candidate.maxAttempts === where.maxAttempts))),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    ingestTile: {
      findMany: async ({
        where,
      }: {
        where: { quadkey: { in: string[] }; attempts: { gte: number } };
      }) =>
        tiles.filter(
          (tile) => where.quadkey.in.includes(tile.quadkey) && tile.attempts >= where.attempts.gte,
        ),
    },
  } as unknown as PrismaClient;
}

describe('classifying what killed a job', () => {
  it('reads the reaper as the host having killed the handler', () => {
    expect(classifyDeath(`${LEASE_EXPIRED_REASON_PREFIX} 12 min with no outcome`)).toEqual({
      cause: 'transient',
      reason: 'the host killed the handler',
    });
  });

  it('reads a malformed query as permanent, because every mirror runs the same Overpass', () => {
    const death = classifyDeath(`${overpassStatusText(400, 'de')}: malformed Overpass QL. line 3`);
    expect(death.cause).toBe('permanent');
  });

  it('agrees with RETRYABLE_STATUS on which statuses are worth another attempt', () => {
    // The two tables are built from one set, so this asserts the derivation rather than a copy.
    // 500 is the one that matters: `overpass.ts` omits it deliberately.
    expect(classifyDeath(overpassStatusText(504, 'kumi')).cause).toBe('transient');
    expect(classifyDeath(overpassStatusText(429, 'kumi')).cause).toBe('transient');
    expect(classifyDeath(overpassStatusText(500, 'kumi')).cause).toBe('permanent');
    expect(classifyDeath(overpassStatusText(400, 'kumi')).cause).toBe('permanent');
  });

  it('classifies the messages the real error types carry, not hand-written copies of them', () => {
    /*
     * The drift this guards: a reworded message would sail past a test asserting its own literal
     * and silently reclassify the failure. These two are constructed by the code that raises them.
     */
    expect(classifyDeath(new IngestDeadlineError('commit', 5_000).message).cause).toBe('transient');
    expect(classifyDeath(new OverpassUnavailableError(30_000).message).cause).toBe('transient');
  });

  it('names the three shapes an overloaded mirror answers 200 with', () => {
    // `OverpassClient` rotates mirrors on each of these, so they are the signature of the overload
    // the ladder exists to span — and the class it would be worst to retire half an hour in.
    expect(
      classifyDeath('Overpass returned a non-JSON body from de: Error: rate_limited').cause,
    ).toBe('transient');
    expect(classifyDeath('Overpass returned unparseable JSON from de').cause).toBe('transient');
    expect(classifyDeath('Overpass reported "runtime error: Query timed out" from de').cause).toBe(
      'transient',
    );
  });

  it('retries a message no rule explains rather than retiring it', () => {
    /*
     * The direction that matters, and the one an earlier version had backwards. Reviving costs at
     * most `REVIVAL_DELAYS_MS.length` bounded attempts; abandoning writes a terminal mark. So an
     * unrecognised phrasing gets the ladder, and only an enumerated cause is retired.
     */
    expect(classifyDeath('TypeError: cannot read properties of undefined').cause).toBe('unknown');
    expect(classifyDeath(null).cause).toBe('unknown');
  });

  it('leaves no registry rule unexercised', () => {
    /*
     * Each rule is one line of a table nothing else reads, so a pattern that silently stops
     * matching would reclassify its whole class with no test going red. Every row here is a string
     * the estate actually raises, matched against the name the registry gives it.
     */
    const samples: Array<[string, string]> = [
      [`${LEASE_EXPIRED_REASON_PREFIX} 12 min with no outcome`, 'the host killed the handler'],
      [overpassStatusText(429, 'de'), 'Overpass refused or failed'],
      ['Overpass gave up after 240000 ms', 'Overpass spent its whole budget'],
      [new OverpassUnavailableError(30_000).message, 'the Overpass breaker was open'],
      ['Overpass returned a non-JSON body from de', 'Overpass answered with an error page'],
      ['Overpass returned unparseable JSON from de', 'Overpass answered unparseable JSON'],
      ['Overpass reported "runtime error" from de', 'Overpass reported the query failed'],
      ['Overpass request failed', 'every Overpass mirror refused'],
      [new IngestDeadlineError('commit', 5_000).message, 'the invocation ran out of clock'],
      ['connect ECONNRESET 10.0.0.1:443', 'the network failed'],
      ["Can't reach database server at postgres:5432", 'the database was unreachable'],
      [
        `${overpassStatusText(400, 'de')}: malformed Overpass QL.`,
        'the Overpass query is malformed',
      ],
      [
        `${overpassStatusText(406, 'de')}: the mirror refused this User-Agent before running`,
        'the mirror refused this User-Agent',
      ],
      ['OVERPASS_USER_AGENT must include a contact URL.', 'OVERPASS_USER_AGENT is not configured'],
      [
        'OVERPASS_USER_AGENT names "switchback.app", which does not reach this project',
        'OVERPASS_USER_AGENT reaches nobody',
      ],
      ['job payload missing "quadkey"', 'the job payload is incomplete'],
      [overpassStatusText(500, 'de'), 'Overpass refused the query itself'],
    ];

    for (const [message, name] of samples) {
      expect(classifyDeath(message).reason, message).toBe(name);
    }
    // Every rule the registry declares is named above, so adding one without a sample fails here.
    expect(new Set(samples.map(([, name]) => name))).toEqual(
      new Set(CAUSE_RULES.map((rule) => rule.name)),
    );
  });
});

describe('reconciling buried jobs', () => {
  it('gives a transient death one more attempt and puts it back on the queue', async () => {
    const row = job();
    const triage = await reconcileDeadJobs(fakeDb([row]), NOW);

    expect(triage.revived).toEqual([row.dedupeKey]);
    expect(row.status).toBe(JobStatus.queued);
    // Exactly one: the claim spends `attempts` up to `maxAttempts`, and the next failure buries it.
    expect(row.maxAttempts - row.attempts).toBe(1);
    expect(row.completedAt).toBeNull();
  });

  it('revives behind live work rather than ahead of it', async () => {
    /*
     * `claimJobs` orders `priority DESC, "runAfter" ASC`, so a revived row left at the band it was
     * buried in — a viewport band, with an old `runAfter` — is claimed strictly before the tile
     * somebody is looking at now. Leaving the column alone was not neutral.
     */
    const row = job({ priority: VIEWPORT_PRIORITY });

    await reconcileDeadJobs(fakeDb([row]), NOW);

    expect(row.priority).toBe(REVIVAL_PRIORITY);
    expect(REVIVAL_PRIORITY).toBeLessThan(VIEWPORT_PRIORITY);
  });

  it('revives a message it cannot explain, on the same ladder', async () => {
    const row = job({ lastError: 'Overpass returned unparseable JSON from de' });

    const triage = await reconcileDeadJobs(fakeDb([row]), NOW);

    expect(triage.revived).toEqual([row.dedupeKey]);
    expect(triage.abandoned).toEqual([]);
  });

  it('keeps the diagnostic on the row it revives', async () => {
    const row = job();
    const before = row.lastError;
    await reconcileDeadJobs(fakeDb([row]), NOW);

    expect(row.lastError).toBe(before);
  });

  it('waits out the rung before reviving', async () => {
    const tooRecent = new Date(NOW.getTime() - (REVIVAL_DELAYS_MS.at(0) ?? 0) + 1);
    const row = job({ completedAt: tooRecent });

    const triage = await reconcileDeadJobs(fakeDb([row]), NOW);

    expect(triage).toEqual({ revived: [], abandoned: [] });
    expect(row.status).toBe(JobStatus.dead);
  });

  it('abandons a malformed query rather than retrying it', async () => {
    const row = job({ lastError: `${overpassStatusText(400, 'de')}: malformed Overpass QL.` });

    const triage = await reconcileDeadJobs(fakeDb([row]), NOW);

    expect(triage.revived).toEqual([]);
    expect(triage.abandoned).toEqual([
      { dedupeKey: row.dedupeKey, cause: 'permanent', reason: 'the Overpass query is malformed' },
    ]);
    expect(row.status).toBe(JobStatus.dead);
    expect(row.lastError).toContain(JOB_ABANDONED_MARKER);
  });

  it('keeps the marker and the cause when the error it quotes is enormous', async () => {
    // `scripts/requeue-jobs.ts --match` reads this string; truncating from the front would take
    // away the token an operator greps for.
    const row = job({
      lastError: `${overpassStatusText(400, 'de')}: malformed Overpass QL. ${'x'.repeat(4000)}`,
    });

    await reconcileDeadJobs(fakeDb([row]), NOW);

    expect(row.lastError?.startsWith(JOB_ABANDONED_MARKER)).toBe(true);
    expect(row.lastError).toContain('the Overpass query is malformed');
    expect(row.lastError?.length).toBeLessThanOrEqual(1000);
  });

  it('stops reviving once the budget is spent', async () => {
    const row = job();
    const db = fakeDb([row]);

    for (let revival = 0; revival < REVIVAL_DELAYS_MS.length; revival += 1) {
      row.completedAt = LONG_AGO;
      row.status = JobStatus.dead;
      row.attempts = row.maxAttempts;
      await reconcileDeadJobs(db, NOW);
    }
    expect(row.maxAttempts).toBe(REVIVAL_CEILING);

    // The budget is spent, so this pass decides rather than waits — no delay applies to it.
    row.status = JobStatus.dead;
    const triage = await reconcileDeadJobs(db, NOW);

    expect(triage.revived).toEqual([]);
    expect(triage.abandoned[0]?.reason).toContain(`${REVIVAL_DELAYS_MS.length} times`);
    expect(row.maxAttempts).toBe(ABANDONED_MAX_ATTEMPTS);
  });

  it('decides an abandoned row once and never again', async () => {
    const row = job({ lastError: 'Overpass 400 from de: malformed Overpass QL.' });
    const db = fakeDb([row]);

    await reconcileDeadJobs(db, NOW);
    const second = await reconcileDeadJobs(db, NOW);

    expect(second).toEqual({ revived: [], abandoned: [] });
  });

  it('leaves a job that is already coming back alone', async () => {
    /*
     * The regression the whole design turns on. `enqueue` clears `attempts` on a terminal row, so
     * a reconciler that read tile state or ignored `status` would restart the ladder of a job that
     * was merely waiting out its backoff — the hazard `queueStaleChildren` and `ensureCoverage`
     * are both built around.
     */
    const waiting = job({
      status: JobStatus.queued,
      attempts: 2,
      completedAt: null,
      runAfter: new Date(NOW.getTime() + 30 * 60_000),
    });

    const triage = await reconcileDeadJobs(fakeDb([waiting]), NOW);

    expect(triage).toEqual({ revived: [], abandoned: [] });
    expect(waiting.attempts).toBe(2);
    expect(waiting.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(waiting.runAfter.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('decides on the job status, not on how long ago the row last finished', async () => {
    const running = job({ status: JobStatus.running, completedAt: LONG_AGO });

    expect(await reconcileDeadJobs(fakeDb([running]), NOW)).toEqual({ revived: [], abandoned: [] });
    expect(running.status).toBe(JobStatus.running);
  });

  it('ignores a job whose attempt budget was never the default', async () => {
    const custom = job({ maxAttempts: 20, attempts: 20 });

    expect(await reconcileDeadJobs(fakeDb([custom]), NOW)).toEqual({ revived: [], abandoned: [] });
  });

  it('keeps a live job out on the select predicate alone', async () => {
    // The update fence is disabled in the double, so this can only pass because the reconciler
    // never selected the row — which is what makes the predicate provably load-bearing.
    const waiting = job({ status: JobStatus.queued, attempts: 2, completedAt: LONG_AGO });

    const triage = await reconcileDeadJobs(fakeDb([waiting], [], { fence: true }), NOW);

    expect(triage).toEqual({ revived: [], abandoned: [] });
    expect(waiting.status).toBe(JobStatus.queued);
    expect(waiting.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('keeps a live job out on the update fence alone', async () => {
    // And the other way round: the select predicate is disabled, so the row reaches the write and
    // only `status: dead` in the fence stops it.
    const waiting = job({ status: JobStatus.queued, attempts: 2, completedAt: LONG_AGO });

    const triage = await reconcileDeadJobs(fakeDb([waiting], [], { select: true }), NOW);

    expect(triage).toEqual({ revived: [], abandoned: [] });
    expect(waiting.status).toBe(JobStatus.queued);
    expect(waiting.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('lets only one of two overlapping sweeps retire the job', async () => {
    const row = job({ lastError: `${overpassStatusText(400, 'de')}: malformed Overpass QL.` });
    const db = fakeDb([row]);

    const [first, second] = await Promise.all([
      reconcileDeadJobs(db, NOW),
      reconcileDeadJobs(db, NOW),
    ]);

    // Same fence as the revive, and it matters for the same reason: two abandonment writes off one
    // reading would report the decision twice on a rule that pages.
    expect(first.abandoned.length + second.abandoned.length).toBe(1);
    expect(row.maxAttempts).toBe(ABANDONED_MAX_ATTEMPTS);
  });

  it('lets only one of two overlapping sweeps grant the attempt', async () => {
    const row = job();
    const db = fakeDb([row]);

    const [first, second] = await Promise.all([
      reconcileDeadJobs(db, NOW),
      reconcileDeadJobs(db, NOW),
    ]);

    // Both read the row; the update is fenced on the `maxAttempts` each read, so one write lands.
    expect(first.revived.length + second.revived.length).toBe(1);
    expect(row.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS + 1);
  });

  it('bounds one pass, so a backlog of burials cannot fill a tick', async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      job({ id: `job-${index}`, dedupeKey: tileJobKey(`02130120${index}`) }),
    );

    const triage = await reconcileDeadJobs(fakeDb(rows), NOW, { limit: 2 });

    expect(triage.revived).toHaveLength(2);
  });
});

describe('what revival is allowed to cost the queue', () => {
  /** `count` more request jobs than the outstanding cap, all buried and all due. */
  function burials(count: number): JobRow[] {
    return Array.from({ length: count }, (_, index) =>
      job({ id: `job-${index}`, dedupeKey: tileJobKey(`1203${String(index).padStart(6, '0')}`) }),
    );
  }

  it('never leaves more revived request jobs outstanding than the cap', async () => {
    /*
     * `admitIngest` counts `{queued, running}` request jobs against `MAX_TILE_QUEUE_DEPTH`, and a
     * `dead` row is not counted — so reviving is the act that re-fills that ceiling. Unbounded, a
     * mass burial comes back faster than a serial drain empties it and refuses every new viewport.
     */
    const rows = burials(REVIVAL_OUTSTANDING_MAX + 20);

    const triage = await reconcileDeadJobs(fakeDb(rows), NOW, { limit: rows.length });

    expect(triage.revived).toHaveLength(REVIVAL_OUTSTANDING_MAX);
    expect(rows.filter((row) => row.status === JobStatus.queued)).toHaveLength(
      REVIVAL_OUTSTANDING_MAX,
    );
  });

  it('counts what it already put on the queue against the next tick', async () => {
    const rows = burials(REVIVAL_OUTSTANDING_MAX + 20);
    const db = fakeDb(rows);

    await reconcileDeadJobs(db, NOW, { limit: rows.length });
    const second = await reconcileDeadJobs(db, NOW, { limit: rows.length });

    // The first tick's revivals are still queued, so the second grants nothing until they drain.
    expect(second.revived).toEqual([]);
  });

  it('revives again once the drain has cleared what it queued', async () => {
    const rows = burials(REVIVAL_OUTSTANDING_MAX + 20);
    const db = fakeDb(rows);

    await reconcileDeadJobs(db, NOW, { limit: rows.length });
    for (const row of rows.filter((candidate) => candidate.status === JobStatus.queued)) {
      row.status = JobStatus.done;
    }
    const second = await reconcileDeadJobs(db, NOW, { limit: rows.length });

    // Self-clearing, which is what separates this from a latch: the count falls as work drains.
    expect(second.revived).toHaveLength(20);
  });

  it('does not abandon a job for the queue being busy', async () => {
    const rows = burials(REVIVAL_OUTSTANDING_MAX + 5);

    const triage = await reconcileDeadJobs(fakeDb(rows), NOW, { limit: rows.length });

    // Out of budget is "not this tick". Retiring here would give up on a job for a reason that
    // says nothing about the job.
    expect(triage.abandoned).toEqual([]);
    expect(rows.filter((row) => row.status === JobStatus.dead)).toHaveLength(5);
  });
});

describe('a window filled with rows the pass cannot act on', () => {
  /** A burial that is due, transient, and therefore revivable only while budget remains. */
  function stuck(index: number): JobRow {
    return job({
      id: `stuck-${index}`,
      dedupeKey: tileJobKey(`3210${String(index).padStart(5, '0')}`),
      // Oldest, so `completedAt asc` puts every one of them ahead of anything buried later.
      completedAt: new Date(LONG_AGO.getTime() - 86_400_000 + index),
    });
  }

  it('still retires a spent burial behind a wall of unrevivable ones', async () => {
    /*
     * **The head-of-line wedge, in the shape that is guaranteed rather than merely possible.** A
     * revival skipped for want of budget writes nothing, so the row keeps its `completedAt` and
     * sorts first again on the next tick, for ever. Sharing one window with retirements meant a
     * handful of those starved every retirement behind them — and under the brake, where the
     * budget is zero by construction, that was certain.
     */
    const wall = Array.from({ length: 8 }, (_, index) => stuck(index));
    const spentRow = job({
      id: 'spent',
      dedupeKey: tileJobKey('321999999'),
      maxAttempts: REVIVAL_CEILING,
      // Buried most recently, so a single window ordered oldest-first would never reach it.
      completedAt: new Date(NOW.getTime() - 60_000),
    });
    const db = fakeDb([...wall, spentRow]);

    const triage = await reconcileDeadJobs(db, NOW, { revive: false, limit: 4 });

    expect(triage.revived).toEqual([]);
    expect(triage.abandoned.map((entry) => entry.dedupeKey)).toEqual([spentRow.dedupeKey]);
    expect(spentRow.maxAttempts).toBe(ABANDONED_MAX_ATTEMPTS);
  });

  it('reaches a fresh permanent burial behind the same wall', async () => {
    // With no budget the only decision left on the ladder window is retiring a permanent cause,
    // and the ones still outstanding are the ones never seen — which are the newest.
    const wall = Array.from({ length: 8 }, (_, index) => stuck(index));
    const broken = job({
      id: 'broken',
      dedupeKey: tileJobKey('321888888'),
      lastError: `${overpassStatusText(400, 'de')}: malformed Overpass QL.`,
      completedAt: new Date(NOW.getTime() - 60 * 60_000),
    });
    const db = fakeDb([...wall, broken]);

    const triage = await reconcileDeadJobs(db, NOW, { revive: false, limit: 4 });

    expect(triage.abandoned.map((entry) => entry.dedupeKey)).toEqual([broken.dedupeKey]);
  });

  it('serves the longest-waiting burial first once there is budget again', async () => {
    // And the ordering flips back: oldest-first is the fair revival order, so the wall is not
    // punished for having been unrevivable.
    const wall = Array.from({ length: 4 }, (_, index) => stuck(index));
    const db = fakeDb(wall);

    const triage = await reconcileDeadJobs(db, NOW, { limit: 2 });

    expect(triage.revived).toEqual([wall[0]?.dedupeKey, wall[1]?.dedupeKey]);
  });
});

describe('the operator brake', () => {
  it('grants no attempts while it is on', async () => {
    const row = job();

    const triage = await reconcileDeadJobs(fakeDb([row]), NOW, { revive: false });

    expect(triage.revived).toEqual([]);
    expect(row.status).toBe(JobStatus.dead);
  });

  it('still retires the burials it has finished with, which needs no queue capacity', async () => {
    const row = job({ lastError: `${overpassStatusText(400, 'de')}: malformed Overpass QL.` });

    const triage = await reconcileDeadJobs(fakeDb([row]), NOW, { revive: false });

    expect(triage.abandoned).toHaveLength(1);
  });
});

describe('a split child the subdivision cap has already stopped', () => {
  const CHILD = '0213012011';
  const child = (): JobRow => job({ dedupeKey: tileJobKey(CHILD) });

  it('is retired rather than given a second budget', async () => {
    /*
     * `queueStaleChildren` refuses a child past `SPLIT_CHILD_ATTEMPT_CAP`, counted on the tile
     * because the job's own counter resets on every revival. Selecting on the job row alone would
     * be a second automatic path through the population that cap exists to close.
     */
    const row = child();
    const db = fakeDb([row], [{ quadkey: CHILD, attempts: SPLIT_CHILD_ATTEMPT_CAP }]);

    const triage = await reconcileDeadJobs(db, NOW);

    expect(triage.revived).toEqual([]);
    expect(triage.abandoned[0]?.reason).toContain('SPLIT_CHILD_ATTEMPT_CAP');
    expect(row.status).toBe(JobStatus.dead);
  });

  it('stops occupying the window once it has been decided', async () => {
    /*
     * **The wedge this replaces a skip to avoid.** A skipped child was written to not at all, so it
     * kept its status, its rung and its `completedAt`, satisfied the same predicate next tick and
     * sorted to the head again — and nothing else clears it, so sixteen capped parents was the
     * whole window and the reconciler stopped doing anything for thirty days.
     */
    const capped = child();
    const ordinary = job({
      id: 'job-ordinary',
      dedupeKey: tileJobKey('021301202'),
      // Buried later, so an undecided capped child ahead of it would take the only slot.
      completedAt: new Date(NOW.getTime() - (REVIVAL_DELAYS_MS.at(0) ?? 0) - 1),
    });
    const db = fakeDb([capped, ordinary], [{ quadkey: CHILD, attempts: SPLIT_CHILD_ATTEMPT_CAP }]);

    await reconcileDeadJobs(db, NOW, { limit: 1 });
    const second = await reconcileDeadJobs(db, NOW, { limit: 1 });

    // The window has moved on: the capped child was decided once, and the ordinary burial behind
    // it is now reachable.
    expect(second.revived).toEqual([ordinary.dedupeKey]);
  });

  it('is revived while it is still under the cap', async () => {
    const row = child();
    const db = fakeDb([row], [{ quadkey: CHILD, attempts: SPLIT_CHILD_ATTEMPT_CAP - 1 }]);

    expect((await reconcileDeadJobs(db, NOW)).revived).toEqual([row.dedupeKey]);
  });

  it('does not apply the cap to a tile at the ingest zoom, whose attempts never reset', async () => {
    // A z9 refreshed across a year accumulates runs legitimately; the cap is a statement about
    // subdivision, not about age.
    const row = job({ dedupeKey: tileJobKey('021301201') });
    const db = fakeDb([row], [{ quadkey: '021301201', attempts: SPLIT_CHILD_ATTEMPT_CAP * 3 }]);

    expect((await reconcileDeadJobs(db, NOW)).revived).toEqual([row.dedupeKey]);
  });
});
