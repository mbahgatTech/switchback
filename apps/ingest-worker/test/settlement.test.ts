import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { LEASE_TIMEOUT_MS, OVERPASS_MAX_TOTAL_MS, drainSlotGate } from '@switchback/ingest';
import type { DrainResult, OverpassQuerier } from '@switchback/ingest';
import {
  classifyDisposition,
  handlerDeadlineMs,
  overpassDeadlineMs,
  runIngestSignal,
  SIGNAL_STRANDED_MARKER,
  StrandedSignalError,
} from '../src/drain';
import type { Drain } from '../src/drain';
import type { WorkerLog } from '../src/log';

const KEY = 'ingest_tile:021231321';

/** Stands in for the shared client so these cases need no `OVERPASS_USER_AGENT`. */
const overpass: OverpassQuerier = { query: async () => ({ elements: [] }) };

function outcome(overrides: Partial<DrainResult> = {}): DrainResult {
  return {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    lost: 0,
    derived: 0,
    requeued: 0,
    retired: 0,
    ...overrides,
  };
}

function fakeLog(): WorkerLog & { lines: Array<[string, string]> } {
  const lines: Array<[string, string]> = [];
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push([level, String(args[0])]);
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

function drainReturning(result: DrainResult): Drain {
  return vi.fn(async () => result);
}
/**
 * The invariant the broker and the queue have to agree on: a message is completed only when its
 * work is done or something else is going to do it. Measured 2026-08-08, before this existed: 42
 * `Executing` against 37 `Executed` on `Functions.ingestDrain`. The five invocations that logged a
 * start and no end — 16:32:42, 17:06:37, 17:28:19, 17:45:12 and 18:24:00 UTC — are handlers the
 * host killed mid-tile, each leaving its `ingest_jobs` lease held by a process that no longer
 * exists.
 */
describe('what a delivery may tell the broker', () => {
  const held = (ageMs: number) => ({
    status: JobStatus.running,
    lockedAt: new Date(Date.now() - ageMs),
  });

  it('completes when the work is finished or deliberately buried', () => {
    const now = Date.now();
    expect(classifyDisposition(null, now)).toBe('settled');
    expect(classifyDisposition({ status: JobStatus.done, lockedAt: new Date() }, now)).toBe(
      'settled',
    );
    expect(classifyDisposition({ status: JobStatus.dead, lockedAt: new Date() }, now)).toBe(
      'settled',
    );
  });

  it('completes when something else will pick the work up', () => {
    const now = Date.now();
    // Both are the pump's to republish: a `queued` row directly, and a dated lease once the reaper
    // has taken it back. Neither depends on the lease's holder still being alive — measured
    // 2026-08-08, five of six redeliveries arrived while a dead holder's lease still looked live.
    expect(classifyDisposition({ status: JobStatus.queued, lockedAt: null }, now)).toBe(
      'rescheduled',
    );
    expect(classifyDisposition(held(LEASE_TIMEOUT_MS - 1_000), now)).toBe('rescheduled');
  });

  it('refuses to complete a job the reaper should already have freed', () => {
    const now = Date.now();
    // A lease past its timeout that is still `running` means the sweep did not run or threw —
    // `drainJobs` and `drainSlotGate` both catch and carry on — so the durable rescheduler is the
    // thing that is broken, and this is the delivery that says so.
    expect(classifyDisposition(held(LEASE_TIMEOUT_MS + 1_000), now)).toBe('stranded');
    // A `running` row with no `lockedAt` is a lease nothing can date, so no cutoff reclaims it.
    expect(classifyDisposition({ status: JobStatus.running, lockedAt: null }, now)).toBe(
      'stranded',
    );
  });

  it('throws on a stranded signal so the host abandons rather than completes', async () => {
    const log = fakeLog();
    const db = {
      ingestJob: {
        findUnique: async () => ({
          status: JobStatus.running,
          lockedAt: new Date(Date.now() - LEASE_TIMEOUT_MS - 60_000),
          lockedBy: 'sb-dead-invocation',
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      runIngestSignal({ dedupeKey: KEY }, log, {
        workerId: 'sb-test',
        deliveryCount: 2,
        drain: drainReturning(outcome({ claimed: 0 })),
        overpass,
        db,
      }),
    ).rejects.toBeInstanceOf(StrandedSignalError);

    expect(log.lines).toContainEqual(['error', expect.stringContaining(SIGNAL_STRANDED_MARKER)]);
  });

  it('strands rather than throwing when the gate sweep fails, so the arm is reachable', async () => {
    /*
     * The two halves of the reachability argument, composed. `drainSlotGate` sweeps before it opens
     * the transaction, so a reclaim that throws leaves the gate admitting a claim rather than
     * aborting the transaction with `25P02` and taking the next statement down with it — which is
     * what previously made `runIngestSignal` rethrow before `assertSettleable` ever ran. With the
     * gate surviving, a lease the sweep failed to take back is still `running` when the disposition
     * is read, which is exactly the state `switchback-ingest-signal-stranded` exists to report.
     */
    const sql = (strings: TemplateStringsArray) => strings.join('?');
    const raw = async (strings: TemplateStringsArray) => {
      if (sql(strings).includes('UPDATE ingest_jobs')) throw new Error('reclaim failed');
      return sql(strings).includes('count(distinct') ? [{ drainers: 0 }] : [];
    };
    const gateDb = {
      $queryRaw: raw,
      $transaction: async (run: (client: unknown) => Promise<unknown>) =>
        run({ $executeRaw: async () => 1, $queryRaw: raw }),
    } as unknown as PrismaClient;

    const batch = await drainSlotGate(gateDb, 1)(async () => ({ primary: [], derived: [] }));
    expect(batch).toEqual({ primary: [], derived: [] });

    const log = fakeLog();
    const strandedDb = {
      ingestJob: {
        findUnique: async () => ({
          status: JobStatus.running,
          lockedAt: new Date(Date.now() - LEASE_TIMEOUT_MS - 1_000),
          lockedBy: 'sb-dead-invocation',
        }),
      },
    } as unknown as PrismaClient;

    await expect(
      runIngestSignal({ dedupeKey: KEY }, log, {
        workerId: 'sb-test',
        deliveryCount: 2,
        drain: drainReturning(outcome({ claimed: 0 })),
        overpass,
        db: strandedDb,
      }),
    ).rejects.toBeInstanceOf(StrandedSignalError);

    expect(log.lines).toContainEqual(['error', expect.stringContaining(SIGNAL_STRANDED_MARKER)]);
  });

  it('completes without reading the row when this invocation did the work', async () => {
    const log = fakeLog();
    const findUnique = vi.fn();
    const db = { ingestJob: { findUnique } } as unknown as PrismaClient;

    await runIngestSignal({ dedupeKey: KEY }, log, {
      workerId: 'sb-test',
      drain: drainReturning(outcome({ claimed: 1, succeeded: 1 })),
      overpass,
      db,
    });

    // Re-reading a row this invocation has just written under its own lease would only
    // reintroduce the race the lease fence exists to close.
    expect(findUnique).not.toHaveBeenCalled();
  });
});

/**
 * The budget arithmetic that keeps a handler ending by finishing a tile rather than by expiring.
 * Before the reserve, the two Overpass queries could spend the whole 540 s and every trail threw
 * `IngestDeadlineError` before `commitTrail` ran once.
 */
describe('the commit reserve', () => {
  const budget = {
    INGEST_DEADLINE_MS: '540000',
    OVERPASS_MAX_TOTAL_MS: '190000',
    INGEST_COMMIT_RESERVE_MS: '150000',
  };

  /**
   * Production, 2026-08-05 to 2026-08-08. `assembled` is logged the moment the tile query returns,
   * so its offset from the invocation start is that query's own wall clock: 34 observations, median
   * 8.3 s, p90 65 s, worst 168.4 s (quadkey 133002102). The region and feature queries follow it, so
   * the worst observed start of a pre-commit query is that same 168.4 s.
   */
  const WORST_TILE_QUERY_MS = 168_400;

  /**
   * The same 34 invocations, of which 23 finished inside the handler budget: work after `assembled`
   * ran 32.9 s to 381.2 s, median ~133 s. The reserve has to clear the median or the commit loop is
   * being promised less than a typical tile needs.
   */
  const MEDIAN_COMMIT_WORK_MS = 133_000;

  /** `OverpassClient`'s `requestTimeoutMs` default — one attempt's abort window. */
  const REQUEST_TIMEOUT_MS = 190_000;

  it('admits every pre-commit query production has been observed to make', () => {
    // The binding number, not the subtraction that produced it. `D - M - R + M + R = D` holds for
    // any three literals; this fails the moment the start-by drops below a query production makes.
    expect(overpassDeadlineMs(budget)).toBeGreaterThanOrEqual(WORST_TILE_QUERY_MS);
  });

  it('reserves at least what the commit loop has been measured to need', () => {
    expect(Number(budget.INGEST_COMMIT_RESERVE_MS)).toBeGreaterThanOrEqual(MEDIAN_COMMIT_WORK_MS);
  });

  it('spends no budget on a retry that could not finish', () => {
    /*
     * Above one attempt's abort window the extra can only fund a *second* attempt, which starts too
     * late to complete a query whose server-side `[timeout:]` is up to 180 s — and every millisecond
     * of it comes out of the start-by above. Below the worst observed tile query it would refuse
     * work that succeeds today.
     */
    expect(OVERPASS_MAX_TOTAL_MS).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    expect(OVERPASS_MAX_TOTAL_MS).toBeGreaterThanOrEqual(WORST_TILE_QUERY_MS);
    expect(Number(budget.OVERPASS_MAX_TOTAL_MS)).toBe(OVERPASS_MAX_TOTAL_MS);

    const client = readFileSync(
      resolve(__dirname, '../../../packages/ingest/src/overpass.ts'),
      'utf8',
    );
    expect(client).toContain(`options.requestTimeoutMs ?? 190_000`);
  });

  /**
   * The three numbers live in `config.ts`, `ingest.bicep` and two prose passages, and the prose is
   * the copy nothing compiles. It has drifted: both sites named the 240,000 that `OVERPASS_MAX_TOTAL_MS`
   * carried before it was sized against the 168.4 s query, and with it a start-by of 150 s rather
   * than the 200 s the shipped trio derives.
   */
  it('is described by the docs in the numbers the code ships', () => {
    const startBySeconds = overpassDeadlineMs(budget) / 1000;
    const maxTotalSeconds = OVERPASS_MAX_TOTAL_MS / 1000;

    const architecture = readFileSync(resolve(__dirname, '../../../docs/architecture.md'), 'utf8');
    expect(architecture).toContain(`\`OVERPASS_MAX_TOTAL_MS\` (${maxTotalSeconds} s)`);
    expect(architecture).toContain(`INGEST_COMMIT_RESERVE_MS\` — ${startBySeconds} s —`);

    const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');
    expect(readme).toMatch(
      new RegExp(`\\|\\s*\`OVERPASS_MAX_TOTAL_MS\`\\s*\\|\\s*\`${OVERPASS_MAX_TOTAL_MS}\`\\s*\\|`),
    );
  });

  it('leaves the commit loop its share whatever Overpass spends', () => {
    /*
     * Stated as the property rather than as the subtraction that produced it: a query starting at
     * the last legal moment and spending its entire budget must still finish with at least the
     * reserve left.
     */
    const startBy = overpassDeadlineMs(budget);
    const worstCaseQueryEnd = startBy + Number(budget.OVERPASS_MAX_TOTAL_MS);
    const leftForCommits = handlerDeadlineMs(budget) - worstCaseQueryEnd;

    expect(leftForCommits).toBeGreaterThanOrEqual(Number(budget.INGEST_COMMIT_RESERVE_MS));
    expect(startBy).toBeGreaterThan(0);
  });

  it('holds the reserve when the budgets move', () => {
    // The same property against a different trio, so the assertion cannot be satisfied by the
    // deployed literals alone.
    const wider = {
      INGEST_DEADLINE_MS: '600000',
      OVERPASS_MAX_TOTAL_MS: '120000',
      INGEST_COMMIT_RESERVE_MS: '90000',
    };
    const leftForCommits =
      handlerDeadlineMs(wider) - (overpassDeadlineMs(wider) + Number(wider.OVERPASS_MAX_TOTAL_MS));

    expect(overpassDeadlineMs(wider)).toBe(390_000);
    expect(leftForCommits).toBeGreaterThanOrEqual(Number(wider.INGEST_COMMIT_RESERVE_MS));
  });

  it('lets an operator tighten the Overpass window but never widen it', () => {
    expect(overpassDeadlineMs({ ...budget, INGEST_OVERPASS_DEADLINE_MS: '60000' })).toBe(60_000);
    expect(overpassDeadlineMs({ ...budget, INGEST_OVERPASS_DEADLINE_MS: '300000' })).toBe(200_000);
  });

  it('still allows the one query the invocation exists to make', () => {
    // A reserve larger than the budget is a misconfiguration, not a reason to make every
    // invocation a no-op that completes its message having done nothing.
    expect(
      overpassDeadlineMs({ INGEST_DEADLINE_MS: '10000', INGEST_COMMIT_RESERVE_MS: '999999' }),
    ).toBeGreaterThan(0);
  });
});
