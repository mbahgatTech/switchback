import { describe, expect, it, vi } from 'vitest';
import { JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { LEASE_TIMEOUT_MS } from '@switchback/ingest';
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
    // Queued is the pump's to republish; a live lease belongs to an invocation still working.
    expect(classifyDisposition({ status: JobStatus.queued, lockedAt: null }, now)).toBe(
      'rescheduled',
    );
    expect(classifyDisposition(held(LEASE_TIMEOUT_MS - 1_000), now)).toBe('rescheduled');
  });

  it('refuses to complete a job held by a lease that has expired', () => {
    const now = Date.now();
    expect(classifyDisposition(held(LEASE_TIMEOUT_MS + 1_000), now)).toBe('stranded');
    // A `running` row with no `lockedAt` is a lease nothing can date, so nothing reclaims it.
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
    OVERPASS_MAX_TOTAL_MS: '240000',
    INGEST_COMMIT_RESERVE_MS: '150000',
  };

  it('leaves the commit loop its share whatever Overpass spends', () => {
    expect(overpassDeadlineMs(budget)).toBe(150_000);
    // Worst case: a query starts at the last legal moment and spends its whole budget.
    expect(overpassDeadlineMs(budget) + 240_000 + 150_000).toBe(handlerDeadlineMs(budget));
  });

  it('lets an operator tighten the Overpass window but never widen it', () => {
    expect(overpassDeadlineMs({ ...budget, INGEST_OVERPASS_DEADLINE_MS: '60000' })).toBe(60_000);
    expect(overpassDeadlineMs({ ...budget, INGEST_OVERPASS_DEADLINE_MS: '300000' })).toBe(150_000);
  });

  it('still allows the one query the invocation exists to make', () => {
    // A reserve larger than the budget is a misconfiguration, not a reason to make every
    // invocation a no-op that completes its message having done nothing.
    expect(
      overpassDeadlineMs({ INGEST_DEADLINE_MS: '10000', INGEST_COMMIT_RESERVE_MS: '999999' }),
    ).toBeGreaterThan(0);
  });
});
