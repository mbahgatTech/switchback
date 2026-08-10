import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  QUEUE_DISTRESS_MARKER,
  QUEUE_HEALTH_MARKER,
  TILE_SPLIT_MARKER,
  TRAIL_LOST_MARKER,
} from '@switchback/ingest';
import type { QueueHealth } from '@switchback/ingest';
import type { PrismaClient } from '@switchback/db';
import { BUILD_COMMIT } from '../src/build';
import { reportQueueHealth } from '../src/health';

const here = fileURLToPath(new URL('.', import.meta.url));

/** A queue that reads exactly this way, whichever statement `queueHealth` uses to ask. */
function fakeDb(reading: QueueHealth): PrismaClient {
  const jobs = [reading.dead, reading.staleLeases, reading.rateLimited];
  let call = 0;
  return {
    ingestJob: {
      count: async () => jobs[call++] ?? 0,
      // Due work plus a terminal transition at the epoch is a stalled drain; no due work is not.
      findFirst: async () => (reading.stalledDrain ? { runAfter: new Date(0) } : null),
      aggregate: async () => ({ _max: { completedAt: new Date(0) } }),
    },
    ingestTile: { count: async () => reading.stuckSubtrees },
    // `orphanedSplits` is a correlated count over the child set, not a Prisma predicate, and the
    // enrichment window is a second raw read — told apart by the only table its query names.
    $queryRaw: async (strings: TemplateStringsArray) =>
      strings.join('').includes('photos photo')
        ? [{ completed: reading.photoSeedBlackout ? 1_000 : 0, seeded: 0 }]
        : [{ count: reading.orphanedSplits }],
  } as unknown as PrismaClient;
}

const CLEAN: QueueHealth = {
  dead: 0,
  staleLeases: 0,
  rateLimited: 0,
  orphanedSplits: 0,
  stuckSubtrees: 0,
  wedgedTiles: 0,
  stalledDrain: 0,
  photoSeedBlackout: 0,
};

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('the queue health report', () => {
  it('logs the marker, with the counts, when the queue is in distress', async () => {
    const log = silentLog();

    await reportQueueHealth(
      fakeDb({ ...CLEAN, dead: 17, staleLeases: 10, orphanedSplits: 6 }),
      log,
    );

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [line] = log.warn.mock.calls[0] as [string];
    expect(line).toContain(QUEUE_DISTRESS_MARKER);
    expect(line).toContain('dead=17');
    expect(line).toContain('staleLeases=10');
    expect(line).toContain('orphanedSplits=6');
  });

  it('says nothing alarming when the queue is clean, but still says it is reading', async () => {
    const log = silentLog();

    await reportQueueHealth(fakeDb(CLEAN), log);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    const [line] = log.info.mock.calls[0] as [string];
    expect(line).toContain(QUEUE_HEALTH_MARKER);
    expect(line).toContain('dead=0');
  });

  /*
   * The deploy waits for a heartbeat carrying the commit it just pushed. Without the commit the
   * wait proves only that *a* host is alive: any build already carrying this file satisfies a
   * bare marker, so a package that failed to mount would pass on the previous build's telemetry.
   */
  it('names the build it came from', async () => {
    const log = silentLog();

    await reportQueueHealth(fakeDb(CLEAN), log);

    const [line] = log.info.mock.calls[0] as [string];
    expect(line).toContain(`${QUEUE_HEALTH_MARKER} build=${BUILD_COMMIT}`);
  });

  /*
   * The heartbeat is what makes silence alarmable, so it must not be conditional on anything —
   * a version that only spoke under distress would leave a stopped worker and a clean queue
   * indistinguishable to every rule that reads this telemetry.
   */
  it('emits the heartbeat under distress as well', async () => {
    const log = silentLog();

    await reportQueueHealth(fakeDb({ ...CLEAN, rateLimited: 3 }), log);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect((log.info.mock.calls[0] as [string])[0]).toContain(QUEUE_HEALTH_MARKER);
    expect((log.warn.mock.calls[0] as [string])[0]).toContain(QUEUE_DISTRESS_MARKER);
  });

  /*
   * The fault this gauge exists for produces no error row and no failed request, so the distress
   * line is the only place it can appear. A seeder writing nothing looked identical to a healthy
   * one for 997 jobs.
   */
  it('names a photo-seed blackout on the distress line', async () => {
    const log = silentLog();

    await reportQueueHealth(fakeDb({ ...CLEAN, photoSeedBlackout: 1 }), log);

    const [line] = log.warn.mock.calls[0] as [string];
    expect(line).toContain(QUEUE_DISTRESS_MARKER);
    expect(line).toContain('photoSeedBlackout=1');
  });

  it('survives a database it cannot read, because the pump hangs off it', async () => {
    const log = silentLog();
    const unreadable = async (): Promise<never> => {
      throw new Error('terminating connection due to administrator command');
    };
    // Every statement fails, not just the first. A stub where only `count` throws leaves the
    // rest of the `Promise.all` resolving, which is not what a dropped connection looks like.
    const broken = {
      ingestJob: { count: unreadable, findFirst: unreadable, aggregate: unreadable },
      ingestTile: { count: unreadable },
      $queryRaw: unreadable,
    } as unknown as PrismaClient;

    await expect(reportQueueHealth(broken, log)).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

/**
 * The alert cannot be read by the code and the code cannot be read by the alert, so the token
 * between them is asserted here. Without this a reworded log line disarms
 * `switchback-ingest-queue-distress` silently, which is the failure the rule beside it was
 * created for in the first place.
 */
describe('the alert that watches it', () => {
  const bicep = readFileSync(resolve(here, '../../../infra/azure/ingest.bicep'), 'utf8');

  it('queries the marker the code logs', () => {
    expect(bicep).toContain(`traces | where message has "${QUEUE_DISTRESS_MARKER}"`);
  });

  it('is declared, enabled and pointed at the action group', () => {
    expect(bicep).toContain(`name: '${QUEUE_DISTRESS_MARKER}'`);
    expect(bicep).toMatch(/switchback-ingest-queue-distress'\n[\s\S]{0,600}?enabled: true/);
  });

  /*
   * The distress rule cannot fire from a worker that is not running, so on its own it reports a
   * stopped process as a healthy one. This is the rule that reads the heartbeat's absence, and
   * it is the only one whose firing condition a stale or dead build cannot suppress.
   */
  it('watches the heartbeat marker going quiet', () => {
    expect(bicep).toContain(`traces | where message has "${QUEUE_HEALTH_MARKER}"`);
    expect(bicep).toContain(`name: 'switchback-ingest-worker-silent'`);
    expect(bicep).toMatch(/switchback-ingest-worker-silent'\n[\s\S]{0,900}?enabled: true/);
  });
});

/**
 * Each of these pins one half of "what makes it fire, and what makes it stop". They are asserted
 * against the template text because nothing else can: the rule lives in Azure and the condition it
 * watches lives in this repository, so a change to either side is silent to the other.
 */
describe('the rules that page a human', () => {
  const bicep = readFileSync(resolve(here, '../../../infra/azure/ingest.bicep'), 'utf8');
  const drainQuery = bicep.split('\n').find((line) => line.includes('name == "ingestDrain"')) ?? '';

  /*
   * The split exit returns `pending` without throwing, so `failJob` never runs and no
   * `ingest-job-failed` is written. Tile 023010230 took that exit on 2026-08-09 having lost 4 of
   * 1519 trails, and this token was the only thing in the estate that marked it.
   */
  it('reads lost ground, which the split exit reports through no other token', () => {
    expect(drainQuery).toContain(`message has "${TRAIL_LOST_MARKER}"`);
  });

  /* Subdivision is the designed answer to a dense tile. It outnumbered every real fault 9 to 7 in
   * the 48 h to 2026-08-09T21:12Z, and a Sev2 on it is a Sev2 on healthy operation. */
  it('does not page on subdivision', () => {
    expect(drainQuery).not.toContain(TILE_SPLIT_MARKER);
  });

  /* 16 rate limits in 48 h, peaking at 4 in any rolling hour, is the ambient behaviour of a free
   * public Overpass. The threshold has to sit above that and below one blocked tile's ~24. */
  it('measures Overpass rate limiting as a rate, not a presence', () => {
    const rule = bicep.slice(bicep.indexOf(`displayName: 'switchback-ingest-overpass-limited'`));
    expect(rule).toMatch(/windowSize: 'PT1H'/);
    expect(rule.slice(0, rule.indexOf('actions:'))).toMatch(/threshold: 8/);
  });

  /*
   * Azure reduces the window's datapoints with the declared aggregation and compares the result to
   * the threshold, so the aggregation decides what the rule can see. `DeadletteredMessages` is
   * published densely — 2880 of 2880 fifteen-minute windows carried a value over the 30 d to
   * 2026-08-09 — so the window really does hold a datapoint per minute, and reducing one here is
   * the same arithmetic the rule performs.
   */
  const REDUCERS: Record<string, (window: readonly number[]) => number> = {
    Maximum: (window) => Math.max(...window),
    Minimum: (window) => Math.min(...window),
    Average: (window) => window.reduce((sum, value) => sum + value, 0) / window.length,
  };

  const deadLetterRule = bicep.slice(bicep.indexOf(`name: 'switchback-ingest-deadletter'`));
  const deadLetterCriteria = deadLetterRule.slice(0, deadLetterRule.indexOf('actions:'));
  const declaredAggregation = /timeAggregation: '(\w+)'/.exec(deadLetterCriteria)?.[1] ?? '';
  const declaredThreshold = Number(/threshold: (\d+)/.exec(deadLetterCriteria)?.[1]);

  /** What Azure would read off this window, using the aggregation the template declares. */
  function reduceWindow(window: readonly number[]): number {
    const reduce = REDUCERS[declaredAggregation];
    if (reduce === undefined) {
      throw new Error(`Service Bus does not publish '${declaredAggregation}' for this metric`);
    }
    return reduce(window);
  }

  /* One message dead-lettered four minutes in and drained six minutes later. `Minimum` reads 0 over
   * this and the operator is never told; the tile's ground stays missing with nothing pointing at
   * it. This is the case the aggregation is chosen for. */
  it('sees a message dead-lettered and drained inside one window', () => {
    expect(reduceWindow([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0])).toBeGreaterThan(
      declaredThreshold,
    );
  });

  /* Service Bus publishes this metric with `supportedAggregationTypes` of Average, Minimum and
   * Maximum, confirmed against the live namespace. `Total` deploys and then never evaluates. */
  it('reads an aggregation Service Bus publishes for this metric', () => {
    expect(['Average', 'Minimum', 'Maximum']).toContain(declaredAggregation);
  });

  /* Clearing needs both halves: a reading that returns to zero on an empty queue, and the rule
   * being willing to act on it. Nothing drains the dead-letter queue by itself, so a resolution can
   * only follow an operator emptying it. */
  it('resolves itself once the queue is empty', () => {
    expect(reduceWindow(new Array<number>(15).fill(0))).not.toBeGreaterThan(declaredThreshold);
    expect(deadLetterCriteria).toContain('autoMitigate: true');
  });
});

/**
 * `ingestPump` is the only process inside the alert's scope that runs on a schedule, so the
 * report and the maintenance sweep both have to sit ahead of `INGEST_PUMP_ENABLED`. That brake is
 * pulled precisely when something is wrong, which is when a queue nobody is reading and a lease
 * nobody is reclaiming are least affordable.
 */
describe('where the report is called from', () => {
  const pump = readFileSync(resolve(here, '../src/functions/pump.ts'), 'utf8');

  it('reports and sweeps before the pump brake returns', () => {
    const reported = pump.indexOf('reportQueueHealth(backgroundPrisma');
    const maintained = pump.indexOf('maintain(context)');
    const brake = pump.indexOf('if (braked())');
    expect(reported).toBeGreaterThan(-1);
    expect(maintained).toBeGreaterThan(-1);
    expect(brake).toBeGreaterThan(-1);
    expect(reported).toBeLessThan(brake);
    expect(maintained).toBeLessThan(brake);
  });

  it("is the estate's only queue-maintenance schedule", () => {
    // `sweepQueue` reclaims expired leases and clears orphaned split markers. It ran on Vercel
    // until the ingestion path there was removed; nothing else calls it on a schedule now.
    expect(pump).toContain('sweepQueue(backgroundPrisma)');
    expect(pump).toContain('pruneFinishedJobs(backgroundPrisma)');
  });
});
