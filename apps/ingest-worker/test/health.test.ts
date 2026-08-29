import { readFileSync, readdirSync } from 'node:fs';
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
  const queryLine = (token: string): string =>
    bicep.split('\n').find((line) => line.includes('query:') && line.includes(token)) ?? '';
  // Located by a token each rule alone carries: `ground-lost` reads the unrecoverable arms,
  // `drain-degraded` the ones with a repair behind them.
  const groundLostQuery = queryLine(TRAIL_LOST_MARKER);
  const drainQuery = queryLine('name == "ingestDrain"');

  /*
   * The split exit returns `pending` without throwing, so `failJob` never runs and no
   * `ingest-job-failed` is written. Tile 023010230 took that exit on 2026-08-09 having lost 4 of
   * 1519 trails, and this token was the only thing in the estate that marked it.
   */
  it('reads lost ground, which the split exit reports through no other token', () => {
    expect(groundLostQuery).toContain(`message has "${TRAIL_LOST_MARKER}"`);
  });

  /* A tile that lost ground pages; a job that will retry does not. The two rules must not both
   * match one event, or the split buys nothing. */
  it('keeps lost ground off the rule that does not page', () => {
    expect(drainQuery).not.toContain(TRAIL_LOST_MARKER);
  });

  /* Subdivision is the designed answer to a dense tile. It outnumbered every real fault 9 to 7 in
   * the 48 h to 2026-08-09T21:12Z, and a Sev2 on it is a Sev2 on healthy operation. */
  it('does not page on subdivision', () => {
    expect(groundLostQuery).not.toContain(TILE_SPLIT_MARKER);
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
    // `sweepQueue` reclaims expired leases, clears orphaned split markers and triages buried
    // jobs. It ran on Vercel until the ingestion path there was removed; nothing else calls it
    // on a schedule now.
    expect(pump).toContain('sweepQueue(backgroundPrisma');
    expect(pump).toContain('pruneFinishedJobs(backgroundPrisma)');
  });

  it('lets the brake stop revivals without stopping the rest of the sweep', () => {
    /*
     * `maintain` runs ahead of `braked()`, deliberately — a stopped pump that also stopped
     * reclaiming would strand every lease a killed invocation held. But reviving is the one part
     * of the sweep that puts work back on the queue, which is exactly what the brake means to
     * stop, so it is the one part the brake reaches.
     *
     * A source-text match, and therefore not the guard — it reds on a rename that changes no
     * behaviour, and a maintainer who "fixes" the string would otherwise be left with nothing.
     * The guard is behavioural and lives in `pump-handler.test.ts`: *stops revivals while the
     * brake is on* and *leaves revivals running while the brake is off* assert the argument
     * `sweepQueue` is actually called with, in both directions. Update this string freely; do not
     * delete those.
     */
    expect(pump).toContain('{ revive: !braked() }');
  });

  it('drains the dead-letter queue from the same maintenance pass', () => {
    // `maintain` is already pinned ahead of the brake above, so being inside it is the whole
    // claim: the queue is drained on a tick that publishes nothing.
    expect(pump).toContain('reconcileDeadLetters(backgroundPrisma');
  });
});

/**
 * Directories that hold no request path, so scanning them would only add noise: build output,
 * dependencies, and the tests that talk *about* these functions rather than calling them.
 */
const UNSCANNED = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.next-e2e',
  '.expo',
  '.turbo',
  'test',
  '__tests__',
]);

/**
 * Every `.ts` and `.tsx` this repository ships, as paths relative to its root.
 *
 * **Walks each workspace whole, not its `src`.** Next's App Router lives at `apps/web/app`, a
 * *sibling* of `src` — twelve `route.ts` HTTP handlers, and every server component and action
 * beside them. A walk rooted at `src` cannot see the tree the deleted Vercel drainer lived in,
 * which is the one tree this assertion exists to watch. Root `scripts/` and `e2e/` are scanned
 * for the same reason: a call is a call wherever it is written.
 */
function sourceFiles(): string[] {
  const root = resolve(here, '../../..');
  const found: string[] = [];

  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // A root this repository does not have. Not a failure of the assertion below.
      return;
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!UNSCANNED.has(entry.name)) walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(path.slice(root.length + 1));
      }
    }
  };

  for (const workspace of ['packages', 'apps']) {
    for (const entry of readdirSync(`${root}/${workspace}`, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${root}/${workspace}/${entry.name}`);
    }
  }
  walk(`${root}/scripts`);
  walk(`${root}/e2e`);
  return found;
}

/**
 * **Recovery must not ride on somebody opening a map, and this is the assertion that holds it.**
 *
 * The repairs are reachable from one timer and from nowhere else. A request path that called any
 * of them would make recovery a function of traffic — the state this estate has already been in,
 * where a cold region with no readers had no reclaim, no split repair and no way back from a
 * burial. Naming the whole permitted set rather than checking the request routers is what makes a
 * *new* caller fail this rather than only a caller in a place somebody thought to look.
 */
describe('what the repairs are reachable from', () => {
  /*
   * Both tests below read every `.ts`/`.tsx` in the repository from disk. Observed between 251 ms
   * and 7.2 s depending on what else is running, which straddles vitest's 5 s default — and this
   * guard failing for the machine's load rather than for a real call is how a guard gets disabled.
   */
  const WALKS_THE_REPO = { timeout: 30_000 };

  // Calls, not mentions: half the ingest package refers to these by name in prose about them.
  const REPAIRS = /(sweepQueue|reconcileDeadJobs|reconcileDeadLetters)\(/;

  const ALLOWED = new Set([
    // Where they are declared — a declaration is a call site to this pattern.
    'packages/ingest/src/maintenance.ts',
    'packages/ingest/src/dead-jobs.ts',
    'apps/ingest-worker/src/dead-letter.ts',
    // The one caller: the timer.
    'apps/ingest-worker/src/functions/pump.ts',
  ]);

  it('reaches the tree the deleted Vercel drainer lived in', WALKS_THE_REPO, () => {
    /*
     * The guard is only worth what it scans, and the walk it replaces rooted at `<workspace>/src`
     * — which does not contain `apps/web/app`, where `api/cron/drain/route.ts` used to be. A call
     * re-added at the historical location passed. These two are the floor.
     */
    const scanned = sourceFiles();
    expect(scanned).toContain('apps/web/app/api/auth/mobile/refresh/route.ts');
    expect(scanned.filter((file) => file.startsWith('apps/web/app/')).length).toBeGreaterThan(20);
    expect(scanned.some((file) => file.startsWith('scripts/'))).toBe(true);
  });

  it('is the timer, and nothing a request can reach', WALKS_THE_REPO, () => {
    const root = resolve(here, '../../..');
    const mentions = sourceFiles().filter((file) =>
      REPAIRS.test(readFileSync(`${root}/${file}`, 'utf8')),
    );

    expect(new Set(mentions)).toEqual(ALLOWED);
  });
});
