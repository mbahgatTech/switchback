import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { QUEUE_DISTRESS_MARKER, QUEUE_HEALTH_MARKER } from '@switchback/ingest';
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
    // `orphanedSplits` is a correlated count over the child set, not a Prisma predicate.
    $queryRaw: async () => [{ count: reading.orphanedSplits }],
  } as unknown as PrismaClient;
}

const CLEAN: QueueHealth = {
  dead: 0,
  staleLeases: 0,
  rateLimited: 0,
  orphanedSplits: 0,
  stuckSubtrees: 0,
  stalledDrain: 0,
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
 * `ingestPump` is the only process inside the alert's scope that runs on a schedule, and it
 * returns early unless `INGEST_QUEUE_DRIVER` is `servicebus` — which production is not. The report
 * has to be ahead of that guard or it never runs on the configuration that needs it.
 */
describe('where the report is called from', () => {
  const pump = readFileSync(resolve(here, '../src/functions/pump.ts'), 'utf8');

  it('runs before the driver guard returns', () => {
    const reported = pump.indexOf('reportQueueHealth(backgroundPrisma');
    const guard = pump.indexOf("ingestQueueDriver() !== 'servicebus'");
    expect(reported).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(reported).toBeLessThan(guard);
  });
});
