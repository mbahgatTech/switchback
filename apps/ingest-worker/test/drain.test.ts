/**
 * The worker's only real decision: which drain outcomes complete a message and which throw it
 * back at the broker.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DrainResult, OverpassQuerier } from '@switchback/ingest';
import {
  LEASE_EXPIRED_MARKER,
  LEASE_MARGIN_MS,
  LEASE_TIMEOUT_MS,
  HOST_FUNCTION_TIMEOUT_MS,
  OVERPASS_MAX_CONCURRENT,
  OVERPASS_MAX_TOTAL_MS,
  OVERPASS_STRAIN_MARKER,
  OverpassDeadlineError,
  SUBTREE_STUCK_MARKER,
  TILE_SPLIT_MARKER,
  TRAIL_LOST_MARKER,
  subdivideMaxZoom,
  withDeadline,
} from '@switchback/ingest';
import { MAX_INGEST_ZOOM } from '@switchback/geo';
import type { PrismaClient } from '@switchback/db';
import {
  COMMIT_RESERVE_MS,
  DERIVED_COMMIT_RESERVE_MS,
  HANDLER_DEADLINE_MS,
  JOB_BURIED_MARKER,
  JOB_FAILED_MARKER,
  SIGNAL_STRANDED_MARKER,
  commitReserveMs,
  overpassDeadlineMs,
  runIngestSignal,
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
    buried: 0,
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

/**
 * A job row that reads as finished, so `assertSettleable` completes the message. Cases that mean
 * to exercise the stranded path live in `settlement.test.ts` and supply their own.
 */
const settledDb = {
  ingestJob: { findUnique: async () => ({ status: 'done', lockedAt: null, lockedBy: null }) },
} as unknown as PrismaClient;

function drainReturning(result: DrainResult): Drain {
  return vi.fn(async () => result);
}

describe('runIngestSignal', () => {
  it('claims exactly the job the message names, and no derived share', async () => {
    const drain = drainReturning(outcome({ claimed: 1, succeeded: 1 }));
    const before = Date.now();

    await runIngestSignal({ dedupeKey: KEY }, fakeLog(), {
      workerId: 'sb-1',
      drain,
      overpass,
      db: settledDb,
    });

    expect(drain).toHaveBeenCalledWith({
      limit: 1,
      derivedLimit: 0,
      dedupeKeys: [KEY],
      workerId: 'sb-1',
      deps: {
        overpass,
        overpassAfterCommits: overpass,
        deadlineAt: expect.any(Number) as number,
        logger: expect.any(Function) as () => void,
      },
    });

    // Every phase gets the same wall clock, not only Overpass — that is the whole point of
    // `deadlineAt`, and passing `undefined` would silently restore the unbounded handler.
    const { deadlineAt } = (
      drain as unknown as { mock: { calls: [{ deps: { deadlineAt: number } }][] } }
    ).mock.calls[0]![0].deps;
    expect(deadlineAt).toBeGreaterThanOrEqual(before + HANDLER_DEADLINE_MS);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + HANDLER_DEADLINE_MS);
  });

  it('hands the pipeline a logger that reaches the host, so a split is not silent', async () => {
    /*
     * The defect this pins: `PipelineDeps.logger` existed but was set on no deployed path, so
     * `log(TILE_SPLIT_MARKER, …)` went to `deps.logger ?? (() => {})` and a whole round was
     * spent inferring "the split path was never reached" from a trace the code could not emit.
     */
    const log = fakeLog();
    const drain = vi.fn(async (options: { deps?: { logger?: (m: string) => void } }) => {
      options.deps?.logger?.(`${TILE_SPLIT_MARKER} 120221203: ran out of clock`);
      return outcome({ claimed: 1, succeeded: 1 });
    }) as unknown as Drain;

    await runIngestSignal({ dedupeKey: KEY }, log, { workerId: 'sb-1', drain, overpass });

    expect(log.lines).toContainEqual(['warn', expect.stringContaining(TILE_SPLIT_MARKER)]);
  });

  it('hands the pipeline an Overpass view that closes before functionTimeout does', async () => {
    let clock = 0;
    const view = withDeadline(
      { query: async () => ({ elements: [] }) },
      overpassDeadlineMs({}),
      () => clock,
    );

    await expect(view.query('[out:json];')).resolves.toBeDefined();

    clock = overpassDeadlineMs({});
    await expect(view.query('[out:json];')).rejects.toBeInstanceOf(OverpassDeadlineError);
  });

  it('completes a message whose job no longer needs doing', async () => {
    const log = fakeLog();

    // Already ready, superseded, running elsewhere or backed off — all reach here as a claim
    // that returned nothing, and none of them is a failure.
    await runIngestSignal({ dedupeKey: KEY }, log, {
      overpass,
      workerId: 'sb-1',
      drain: drainReturning(outcome()),
      db: settledDb,
    });

    expect(log.lines).toEqual([['info', expect.stringContaining('nothing claimable') as string]]);
  });

  it('completes a message whose handler threw, and says so', async () => {
    const log = fakeLog();

    // `drainJobs` caught it, wrote `lastError` and scheduled the retry from the backoff ladder.
    // Rethrowing would redeliver immediately and spend a second attempt.
    await expect(
      runIngestSignal({ dedupeKey: KEY }, log, {
        overpass,
        workerId: 'sb-1',
        drain: drainReturning(outcome({ claimed: 1, failed: 1 })),
      }),
    ).resolves.toBeDefined();

    // The token, not the prose: `switchback-ingest-drain-degraded` reads this arm, and a job whose
    // retry is still scheduled must not reach the rule that pages.
    expect(log.lines).toContainEqual(['error', expect.stringContaining(JOB_FAILED_MARKER)]);
    expect(log.lines).not.toContainEqual(['error', expect.stringContaining(JOB_BURIED_MARKER)]);
  });

  it('reports a burial with its own token, so the paging rule can tell it from a retry', async () => {
    const log = fakeLog();

    await runIngestSignal({ dedupeKey: KEY }, log, {
      overpass,
      workerId: 'sb-1',
      drain: drainReturning(outcome({ claimed: 1, failed: 1, buried: 1 })),
    });

    // `buried` is a subset of `failed`, so the retry line must not also appear — an operator
    // reading both would see two events where one job died.
    expect(log.lines).toContainEqual(['error', expect.stringContaining(JOB_BURIED_MARKER)]);
    expect(log.lines).not.toContainEqual(['error', expect.stringContaining(JOB_FAILED_MARKER)]);
  });

  it.each([
    ['deferred', outcome({ claimed: 1, deferred: 1 }), 'no handler'],
    ['lost', outcome({ claimed: 1, lost: 1 }), 'lease expired'],
    ['a reclaimed lease', outcome({ requeued: 2 }), 'reclaimed 2'],
  ])('reports %s rather than passing over it', async (_label, result, expected) => {
    const log = fakeLog();

    await runIngestSignal({ dedupeKey: KEY }, log, {
      overpass,
      workerId: 'sb-1',
      drain: drainReturning(result),
      db: settledDb,
    });

    expect(log.lines.map(([, line]) => line).join('\n')).toContain(expected);
  });

  it('rethrows a claim that failed outright, so the message is redelivered', async () => {
    const log = fakeLog();
    const drain: Drain = vi.fn(async () => {
      throw new Error('connection refused');
    });

    // The only failure `drainJobs` does not handle itself, and the only one worth a redelivery.
    // Five of them is what a dead-lettered message means.
    await expect(
      runIngestSignal({ dedupeKey: KEY }, log, { workerId: 'sb-1', drain, overpass }),
    ).rejects.toThrow('connection refused');

    expect(log.lines).toContainEqual(['error', expect.stringContaining('could not claim')]);
  });
});

/**
 * The reserve exists to protect a tile's commit fan-out. Charging it to a job that has no fan-out
 * takes the wall clock off the only phase that job spends any in.
 */
describe('the commit reserve, per job kind', () => {
  it('holds back the tile reserve for a tile', () => {
    expect(commitReserveMs('ingest_tile:021231321', {})).toBe(COMMIT_RESERVE_MS);
    expect(commitReserveMs('refresh_tile:021231321', {})).toBe(COMMIT_RESERVE_MS);
  });

  it('holds back far less for a job that commits at most one trail', () => {
    // `processRoute` ends in a single `commitTrail`; `enrichTrailPhotos` commits no trail at all.
    expect(commitReserveMs('ingest_route:120118', {})).toBe(DERIVED_COMMIT_RESERVE_MS);
    expect(commitReserveMs('enrich_trail:abc123', {})).toBe(DERIVED_COMMIT_RESERVE_MS);
    expect(DERIVED_COMMIT_RESERVE_MS).toBeLessThan(COMMIT_RESERVE_MS);
  });

  it('gives a route a wider start-by than a tile, out of the same handler budget', () => {
    /*
     * The defect this pins. A route job's whole budget goes on `processRoute`'s recursive relation
     * fetches, and the tile reserve refuses them 150 s early. Production 2026-08-10: 11 of 11
     * `ingest_route` attempts failed, 10 of them with "Overpass deadline for this invocation
     * passed Ns ago" against a 200 s start-by.
     */
    const route = overpassDeadlineMs({}, 'ingest_route:120118');
    const tile = overpassDeadlineMs({}, 'ingest_tile:021231321');
    expect(route).toBeGreaterThan(tile);
    expect(route - tile).toBe(COMMIT_RESERVE_MS - DERIVED_COMMIT_RESERVE_MS);

    // Still inside the handler's own clock, reserve included — widening the window must not push
    // the last query past the point the process is killed.
    expect(route + OVERPASS_MAX_TOTAL_MS + DERIVED_COMMIT_RESERVE_MS).toBeLessThanOrEqual(
      HANDLER_DEADLINE_MS,
    );
  });

  it('never lets a tightened reserve widen the derived one', () => {
    // An operator lowering `INGEST_COMMIT_RESERVE_MS` is tightening a budget; it must not
    // accidentally relax the branch that already sits below it.
    expect(commitReserveMs('ingest_route:1', { INGEST_COMMIT_RESERVE_MS: '30000' })).toBe(30_000);
    expect(commitReserveMs('ingest_route:1', { INGEST_COMMIT_RESERVE_MS: '400000' })).toBe(
      DERIVED_COMMIT_RESERVE_MS,
    );
  });

  it('falls back to the tile reserve for a key it cannot classify', () => {
    // An unknown or malformed key must not silently buy itself a wider window.
    expect(commitReserveMs('something-with-no-colon', {})).toBe(COMMIT_RESERVE_MS);
    expect(commitReserveMs('ingest_network:0213', {})).toBe(COMMIT_RESERVE_MS);
    expect(overpassDeadlineMs({})).toBe(overpassDeadlineMs({}, 'ingest_tile:0213'));
  });
});

/**
 * The reconciliation `src/drain.ts` documents, checked against the files that actually carry the
 * numbers. Asserting `300_000 + 240_000 < 600_000` on literals proves only that the author can
 * add: it stays green when a deployed value moves, which is the only way this can break.
 */
describe('the invocation budget the host enforces', () => {
  const bicep = readFileSync(resolve(__dirname, '../../../infra/azure/ingest.bicep'), 'utf8');
  const host = JSON.parse(readFileSync(resolve(__dirname, '../host.json'), 'utf8')) as {
    functionTimeout: string;
    extensions: { serviceBus: { maxConcurrentCalls: number } };
  };

  /** One `name:`/`value:` pair out of the template's `appSettings` array. */
  function appSetting(name: string): number {
    const found = new RegExp(`name: '${name}'\\s*\\r?\\n\\s*value: '([^']+)'`).exec(bicep);
    if (!found) throw new Error(`${name} is not set in infra/azure/ingest.bicep`);
    return Number(found[1]);
  }

  const [hours = 0, minutes = 0, seconds = 0] = host.functionTimeout.split(':').map(Number);
  const functionTimeoutMs = (hours * 3600 + minutes * 60 + seconds) * 1000;

  it('deploys the two budgets the code falls back to', () => {
    // Drift on either side is the failure. A template that stops setting them lands on these
    // defaults; a template that sets something else is no longer the thing reasoned about.
    expect(appSetting('OVERPASS_MAX_TOTAL_MS')).toBe(OVERPASS_MAX_TOTAL_MS);
    expect(appSetting('INGEST_DEADLINE_MS')).toBe(HANDLER_DEADLINE_MS);
    expect(appSetting('INGEST_COMMIT_RESERVE_MS')).toBe(COMMIT_RESERVE_MS);
  });

  it('leaves the Overpass start-by moment to the derivation, not the template', () => {
    // `overpassDeadlineMs` takes min(configured, derived), so a template value can only be inert
    // or — if the three budgets above ever move — a loosening of the one bound whose failure mode
    // is an Overpass IP block. The derivation already guarantees the three add up, so the setting
    // has no safe value to hold. It stays absent, and an operator tightening the clamp during an
    // incident still works because the code reads the variable.
    expect(bicep).not.toMatch(/name: 'INGEST_OVERPASS_DEADLINE_MS'/);
  });

  it('leaves the handler time to write the tile after Overpass is done', () => {
    expect(functionTimeoutMs).toBe(600_000);
    expect(overpassDeadlineMs({}) + OVERPASS_MAX_TOTAL_MS).toBeLessThan(functionTimeoutMs);
  });

  it('stops every phase, not only Overpass, before the host stops the process', () => {
    // The outer bound has to cover the Overpass worst case, or a query could start inside its
    // own deadline and finish outside the handler's — and it has to leave the host room for
    // whichever phase was mid-flight when it struck.
    expect(HANDLER_DEADLINE_MS).toBeGreaterThanOrEqual(
      overpassDeadlineMs({}) + OVERPASS_MAX_TOTAL_MS,
    );
    expect(functionTimeoutMs - HANDLER_DEADLINE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('takes one message at a time, which is what makes the two budgets additive', () => {
    // With two messages in one process a query can wait for a concurrency slot, and that wait
    // is charged to neither budget — the sum above would stop bounding the invocation.
    expect(host.extensions.serviceBus.maxConcurrentCalls).toBe(1);
  });
});

/**
 * The four rows both READMEs present as "checkable rather than believed". Their failure costs
 * the egress IP rather than one invocation, and until now nothing asserted any of them: the
 * chain is one host instance, one Node process in it, one `OverpassClient` in that process (a
 * module singleton, so not a number to assert here) and two requests inside the client.
 */
describe('the Overpass concurrency clamp, from the template', () => {
  const bicep = readFileSync(resolve(__dirname, '../../../infra/azure/ingest.bicep'), 'utf8');

  function appSetting(name: string): string {
    const found = new RegExp(`name: '${name}'\\s*\\r?\\n\\s*value: '([^']+)'`).exec(bicep);
    if (!found) throw new Error(`${name} is not set in infra/azure/ingest.bicep`);
    return found[1]!;
  }

  it('caps the app at one host instance', () => {
    expect(/functionAppScaleLimit:\s*1\b/.test(bicep)).toBe(true);
    expect(appSetting('WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT')).toBe('1');
  });

  it('runs one Node process in that instance', () => {
    expect(appSetting('FUNCTIONS_WORKER_PROCESS_COUNT')).toBe('1');
  });

  it('lets the one client hold two requests', () => {
    expect(Number(appSetting('OVERPASS_MAX_CONCURRENT'))).toBe(OVERPASS_MAX_CONCURRENT);
  });
});

/**
 * The alerts have to fire on the failures this worker actually produces, and the split between them
 * has to hold. A job that fails is caught by `drainJobs`, recorded on the row, and returned as a
 * successful invocation — so a rule reading only `requests` is structurally blind to it.
 *
 * The two queries are located by a token each rule alone contains, not by position: the template
 * holds several scheduled rules and a bare `query:` match binds to whichever is declared first.
 */
describe('the drain alerts, from the template', () => {
  const bicep = readFileSync(resolve(__dirname, '../../../infra/azure/ingest.bicep'), 'utf8');
  const queries = bicep
    .split('\n')
    .map((line) => /query: '([^']+)'/.exec(line)?.[1] ?? '')
    .filter(Boolean);
  const queryContaining = (token: string): string => queries.find((q) => q.includes(token)) ?? '';

  const groundLost = queryContaining(TRAIL_LOST_MARKER);
  const degraded = queryContaining('name == "ingestDrain"');
  const pumpFailing = queryContaining('name == "ingestPump"');

  it('reads the recoverable arms on the rule that does not page', () => {
    // The coupling that keeps this honest: reword the sentence and the test still passes;
    // change the token on either side alone and it does not.
    expect(degraded).toContain(JOB_FAILED_MARKER);
    expect(degraded).toContain(LEASE_EXPIRED_MARKER);
    expect(degraded).toContain('success == false');
    expect(degraded).toContain('traces');
  });

  it('routes a burial to the paging rule and a retry away from it', () => {
    /*
     * The whole point of the split. `failJob` reschedules below `maxAttempts` and buries only the
     * last attempt, so a rule matching the failure alone pages for work that re-runs unaided.
     */
    expect(groundLost).toContain(JOB_BURIED_MARKER);
    expect(groundLost).not.toContain(JOB_FAILED_MARKER);
    expect(degraded).not.toContain(JOB_BURIED_MARKER);
  });

  it('keeps the buried token free of the retry token as a substring', () => {
    // `has "ingest-job-failed"` would match a burial line that embedded the same phrase, which
    // would put every buried job on both rules and undo the split silently.
    expect(JOB_BURIED_MARKER).not.toContain(JOB_FAILED_MARKER);
  });

  /*
   * A split is the designed answer to a dense tile — 9 of them against 7 real faults in the 48 h to
   * 2026-08-09T21:12Z — so it must not page. What must still page is a split that lost ground on
   * the way: `splitTile` returns `pending` without throwing, `failJob` never runs, and
   * `TRAIL_LOST_MARKER` inside the split line is the only token left marking it.
   */
  it('separates a subtree that is stuck from a tile that merely split', () => {
    expect(groundLost).toContain(SUBTREE_STUCK_MARKER);
    expect(groundLost).toContain(TRAIL_LOST_MARKER);
    expect(groundLost).not.toContain(TILE_SPLIT_MARKER);
  });

  it('reads a killed handler through the reaper, not through the redelivery', () => {
    /*
     * A killed handler is discovered by `reclaimExpiredJobs`, not by the redelivery — the reclaim
     * runs ahead of the claim, so by the time a redelivered message is classified the row is
     * already back to `queued`. That reclaim is the repair working, so it sits on the Sev3 rule.
     */
    expect(degraded).toContain(LEASE_EXPIRED_MARKER);
    expect(groundLost).not.toContain(LEASE_EXPIRED_MARKER);
  });

  it('keeps a separate arm for the strand no reclaim can free', () => {
    // `lockedAt < cutoff` never matches NULL, so a `running` row with no `lockedAt` is permanent.
    expect(groundLost).toContain(SIGNAL_STRANDED_MARKER);
  });

  it('watches the pump for a sustained rejection rather than a single tick', () => {
    // One rejected tick is answered by the next one two minutes later; `worker-silent` cannot see
    // either, because the heartbeat is written before the publish.
    expect(pumpFailing).toContain('success == false');
    expect(pumpFailing).not.toContain('ingestDrain');
  });

  it('gives every drain rule a query that returns a row when nothing matches', () => {
    /*
     * `summarize` with no `by` yields exactly one row holding 0, so a quiet window is a measurement
     * below threshold. The bare `| project timestamp` form yields none, and an alert that never
     * observes "below threshold" never resolves — which is how ten `overpass-limited` instances
     * came to sit `Fired` under `autoMitigate: true`.
     */
    for (const query of [groundLost, degraded, pumpFailing]) {
      expect(query).toMatch(/\|\s*summarize\s+\w+\s*=\s*count\(\)\s*$/);
    }
  });

  it('lets every scheduled rule in the template clear itself', () => {
    const autoMitigate = bicep
      .split('\n')
      .map((line) => /^\s*autoMitigate: (true|false)$/.exec(line)?.[1])
      .filter((v): v is string => v !== undefined);
    expect(autoMitigate.length).toBeGreaterThan(0);
    expect(autoMitigate).not.toContain('false');
  });

  it('exempts traces from sampling, since both trace arms are what it reads', () => {
    const host = JSON.parse(readFileSync(resolve(__dirname, '../host.json'), 'utf8')) as {
      logging: { applicationInsights: { samplingSettings: { excludedTypes?: string } } };
    };
    expect(host.logging.applicationInsights.samplingSettings.excludedTypes).toContain('Trace');
  });

  it('takes the subdivision ceiling from a parameter with no default on either side', () => {
    /*
     * A literal in the template would undo an operator's `az functionapp config appsettings set
     * INGEST_SUBDIVIDE_MAX_ZOOM=9` on the next routine deploy, because an application-settings
     * write replaces the collection whole. A *fallback* in `ingest.bicepparam` is the same defect
     * inverted: the live app holds `11`, so a deploy from a shell that forgot to export it would
     * silently write `9` — and `9` is off, not safe. `canSubdivide(9, 9)` is false, so a dense z9
     * tile is failed rather than split, which is the 540 s overrun this exists to bound.
     */
    const setting = /name: 'INGEST_SUBDIVIDE_MAX_ZOOM'\s*\r?\n\s*value: ([^\s]+)/.exec(bicep)?.[1];
    expect(setting).toBe('ingestSubdivideMaxZoom');
    expect(bicep).toContain('param ingestSubdivideMaxZoom string');
    expect(bicep).not.toContain('param ingestSubdivideMaxZoom string =');

    const params = readFileSync(
      resolve(__dirname, '../../../infra/azure/ingest.bicepparam'),
      'utf8',
    );
    expect(params).toContain(
      "param ingestSubdivideMaxZoom = readEnvironmentVariable('INGEST_SUBDIVIDE_MAX_ZOOM')",
    );
    expect(params).not.toContain("readEnvironmentVariable('INGEST_SUBDIVIDE_MAX_ZOOM', ");
  });

  it('declares the package URL, so a template deploy does not leave the app codeless', () => {
    /*
     * An application-settings write replaces the collection whole, so omitting
     * `WEBSITE_RUN_FROM_PACKAGE` meant any deployment that ran without a package push unmounted the
     * code. No fallback for the same reason as the ceiling above: a default would point the app at
     * some other build.
     */
    expect(bicep).toContain("name: 'WEBSITE_RUN_FROM_PACKAGE'");
    expect(bicep).toContain('value: packageUrl');
    expect(bicep).toContain('param packageUrl string');
    expect(bicep).not.toContain('param packageUrl string =');

    const params = readFileSync(
      resolve(__dirname, '../../../infra/azure/ingest.bicepparam'),
      'utf8',
    );
    expect(params).toContain("param packageUrl = readEnvironmentVariable('INGEST_PACKAGE_URL')");
    expect(params).not.toContain("readEnvironmentVariable('INGEST_PACKAGE_URL', ");
  });

  it('reads a deployed ceiling of 11 as two levels of subdivision, and 9 as off', () => {
    // Literals rather than `subdivideMaxZoom`'s own fallback: the fallback is what every
    // *invalid* input returns, so comparing the two would hold for an implementation that
    // ignored its argument entirely.
    const claim = { INGEST_TRAIL_IDENTITY: 'claim' };
    expect(subdivideMaxZoom({ ...claim, INGEST_SUBDIVIDE_MAX_ZOOM: '11' })).toBe(11);
    expect(subdivideMaxZoom({ ...claim, INGEST_SUBDIVIDE_MAX_ZOOM: '10' })).toBe(10);
    expect(subdivideMaxZoom({ ...claim, INGEST_SUBDIVIDE_MAX_ZOOM: '9' })).toBe(9);
    expect(MAX_INGEST_ZOOM).toBeGreaterThanOrEqual(11);
  });

  it('ships both halves of the pairing, so a deployed ceiling cannot act alone', () => {
    // The template setting the ceiling without the identity flag would read as subdivision
    // enabled while `subdivideMaxZoom` silently held it at 9 — or, once someone "fixed" that,
    // would split tiles with the identity defect still live.
    const identity = /name: 'INGEST_TRAIL_IDENTITY'\s*\r?\n\s*value: ([^\s]+)/.exec(bicep)?.[1];
    expect(identity).toBe('ingestTrailIdentity');
    expect(bicep).toContain('param ingestTrailIdentity string');
    expect(bicep).not.toContain('param ingestTrailIdentity string =');

    const params = readFileSync(
      resolve(__dirname, '../../../infra/azure/ingest.bicepparam'),
      'utf8',
    );
    /*
     * No fallback, unlike the ceiling above, and the asymmetry is the point. The live app reads
     * `claim`; an application-settings write replaces the collection whole; so a fallback of
     * `osm-id` would revert a deployed control on any deploy that forgot the export, silently and
     * with nothing in the output naming the flag. Unset must fail the build instead.
     */
    expect(params).toContain(
      "param ingestTrailIdentity = readEnvironmentVariable('INGEST_TRAIL_IDENTITY')",
    );
    expect(params).not.toMatch(/readEnvironmentVariable\('INGEST_TRAIL_IDENTITY',/);

    // Deployed as committed, the ceiling is inert whatever it says.
    expect(
      subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: '11', INGEST_TRAIL_IDENTITY: 'osm-id' }),
    ).toBe(9);
  });
});

/**
 * The numbers that decide whether a killed handler's work is re-run or silently dropped. They live
 * in three separate files — `host.json`, `ingest.bicep`, `jobs.ts` — so nothing but this test stops
 * one of them moving alone. That the freed row is then *reached* is a property of `runPump`, and is
 * asserted in `apps/ingest-worker/test/pump.test.ts`, which runs it.
 */
describe('the lease, the lock and the host clock', () => {
  const bicep = readFileSync(resolve(__dirname, '../../../infra/azure/ingest.bicep'), 'utf8');
  const host = JSON.parse(readFileSync(resolve(__dirname, '../host.json'), 'utf8')) as {
    functionTimeout: string;
    extensions: { serviceBus: { maxAutoLockRenewalDuration: string } };
  };

  function clockToMs(value: string): number {
    const [hours = 0, minutes = 0, seconds = 0] = value.split(':').map(Number);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  /** `PT5M`, `PT30S`, `PT1H` — the ISO-8601 durations ARM accepts for a queue. */
  function durationToMs(value: string): number {
    const found = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
    if (!found) throw new Error(`${value} is not a duration this test understands`);
    const [, hours, minutes, seconds] = found;
    return (Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;
  }

  function queueSetting(name: string): string {
    const found = new RegExp(`${name}: '([^']+)'`).exec(bicep)?.[1];
    if (!found) throw new Error(`${name} is not set in infra/azure/ingest.bicep`);
    return found;
  }

  const functionTimeoutMs = clockToMs(host.functionTimeout);
  const lockDurationMs = durationToMs(queueSetting('lockDuration'));
  const dedupeWindowMs = durationToMs(queueSetting('duplicateDetectionHistoryTimeWindow'));

  it('mirrors the host timeout the lease is derived from', () => {
    // `LEASE_TIMEOUT_MS` is `HOST_FUNCTION_TIMEOUT_MS + LEASE_MARGIN_MS`, and the first of those is
    // a copy of a value that lives in host.json. This is what stops the copy going stale.
    expect(HOST_FUNCTION_TIMEOUT_MS).toBe(functionTimeoutMs);
    expect(LEASE_TIMEOUT_MS).toBe(functionTimeoutMs + LEASE_MARGIN_MS);
  });

  it('stops the handler before the host kills it', () => {
    // Past `HANDLER_DEADLINE_MS` no phase begins, which leaves the host's remaining budget for
    // whichever phase was already running plus the bookkeeping that writes the outcome.
    expect(HANDLER_DEADLINE_MS).toBeLessThan(functionTimeoutMs);
  });

  it('keeps a live handler from losing its lease while it is still working', () => {
    /*
     * If the lease could expire under a running handler, another process would reclaim the row and
     * claim the tile, and both would commit the same trails.
     */
    expect(functionTimeoutMs).toBeLessThan(LEASE_TIMEOUT_MS);
  });

  it('renews a running handler lock well past the moment the host would kill it', () => {
    const renewalMs = clockToMs(host.extensions.serviceBus.maxAutoLockRenewalDuration);
    expect(renewalMs).toBeGreaterThan(functionTimeoutMs);
  });

  it('records that a redelivery cannot be the repair, because no lease value would make it one', () => {
    /*
     * The redelivery gap starts at `lockDuration`: auto-renewal stops the instant the process dies,
     * and an eviction can kill it before the first renewal, so the message can return one whole
     * `lockDuration` after delivery and no later bound applies. Measured over 2026-08-08's six
     * redeliveries the gaps were 299.9, 300.0, 455.0, 592.8, 708.1 and 1012.7 s — the two at the
     * floor are exactly `lockDuration`, and five of the six landed while the lease was still live.
     *
     * For a redelivery to always find an expired lease the lease would have to be shorter than
     * `lockDuration`; to be safe under a live handler it must be longer than `functionTimeout`.
     * This asserts those two requirements really do conflict, so the fix is never to retune the
     * lease — it is `ingestPump`, below.
     */
    expect(lockDurationMs).toBeLessThan(functionTimeoutMs);
    expect(lockDurationMs).toBeLessThan(LEASE_TIMEOUT_MS);
  });

  it('keeps the dedupe window shorter than the lease, so a republish is not read as a duplicate', () => {
    /*
     * **The template relation the durability of a reclaimed row rests on.** A redelivery that finds
     * a live-looking lease completes the message, so what re-runs the work is the reaper's
     * republish. Duplicate detection is keyed on `messageId = dedupeKey` and measured from the
     * original enqueue, and the reclaim cannot fire before `LEASE_TIMEOUT_MS` — so if that window
     * outlived the lease, the republish would be discarded as a duplicate of the message that was
     * already completed, and the tile would be lost with nothing logged anywhere.
     *
     * Raising `duplicateDetectionHistoryTimeWindow` to PT15M is the plausible tuning that would do
     * it, and this is what refuses it.
     */
    expect(dedupeWindowMs).toBeLessThan(LEASE_TIMEOUT_MS);
  });

  it('expires stale signals rather than dead-lettering them, so the pump is not suppressed', () => {
    /*
     * **Both halves of the expiry policy are chosen against the pump, and each looks safer moved
     * the other way.** `runPump` publishes nothing while `activeMessageCount` is at or above
     * `PUMP_LOW_WATER`, and `service-bus.ts` reads that count from the queue's ARM `countDetails`,
     * where an expired message no longer appears. So a finite TTL is what returns the pump to
     * work after a stoppage: raise it and stale doorbells hold the active count up, suppressing
     * the one process that can re-derive the rows.
     *
     * Dead-lettering them instead would clear the active count and cost the dead-letter alert its
     * meaning — `switchback-ingest-deadletter` exists to say the worker could not reach Postgres
     * five times, and a DLQ full of stale wake-ups says nothing.
     */
    const ttlMs = durationToMs(queueSetting('defaultMessageTimeToLive'));
    // Anchored to the property, not the prose above it, which names the rejected value too.
    expect(bicep).toMatch(/^\s+deadLetteringOnMessageExpiration: false$/m);

    // A republish after expiry has to be a fresh message, not one the dedupe window collapses.
    expect(dedupeWindowMs).toBeLessThan(ttlMs);

    // The count the pump reads must exclude expired messages, or the TTL buys nothing.
    const serviceBus = readFileSync(resolve(__dirname, '../src/service-bus.ts'), 'utf8');
    expect(serviceBus).toContain('countDetails?.activeMessageCount');
  });
});

/**
 * The rule that watches Overpass rate limiting — the failure mode that gets the egress IP blocked
 * and takes ingestion down for the whole product.
 */
describe('the Overpass rate-limit alert, from the template', () => {
  const bicep = readFileSync(resolve(__dirname, '../../../infra/azure/ingest.bicep'), 'utf8');

  it('reads the request path, which is where a 429 arrives', () => {
    /*
     * `queueHealth.rateLimited` counts `lastError` containing '429', so it sees only a rate limit
     * that outlived the retry budget and failed a job. Failover absorbs most of them first.
     */
    const rule = bicep.slice(bicep.indexOf("name: 'switchback-ingest-overpass-limited'"));
    const query = /query: '([^']+)'/.exec(rule)?.[1] ?? '';
    expect(query).toContain(OVERPASS_STRAIN_MARKER);
    expect(query).toContain('status=429');
  });
});
