/**
 * The worker's only real decision: which drain outcomes complete a message and which throw it
 * back at the broker.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DrainResult, OverpassQuerier } from '@switchback/ingest';
import {
  OVERPASS_MAX_CONCURRENT,
  OVERPASS_MAX_TOTAL_MS,
  OverpassDeadlineError,
  SUBTREE_STUCK_MARKER,
  TILE_SPLIT_MARKER,
  subdivideMaxZoom,
  withDeadline,
} from '@switchback/ingest';
import { MAX_INGEST_ZOOM } from '@switchback/geo';
import {
  HANDLER_DEADLINE_MS,
  JOB_FAILED_MARKER,
  OVERPASS_DEADLINE_MS,
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

describe('runIngestSignal', () => {
  it('claims exactly the job the message names, and no derived share', async () => {
    const drain = drainReturning(outcome({ claimed: 1, succeeded: 1 }));
    const before = Date.now();

    await runIngestSignal({ dedupeKey: KEY }, fakeLog(), { workerId: 'sb-1', drain, overpass });

    expect(drain).toHaveBeenCalledWith({
      limit: 1,
      derivedLimit: 0,
      dedupeKeys: [KEY],
      workerId: 'sb-1',
      deps: {
        overpass,
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
      OVERPASS_DEADLINE_MS,
      () => clock,
    );

    await expect(view.query('[out:json];')).resolves.toBeDefined();

    clock = OVERPASS_DEADLINE_MS;
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

    expect(log.lines).toContainEqual(['error', expect.stringContaining('handler failed')]);
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
    expect(appSetting('INGEST_OVERPASS_DEADLINE_MS')).toBe(OVERPASS_DEADLINE_MS);
    expect(appSetting('OVERPASS_MAX_TOTAL_MS')).toBe(OVERPASS_MAX_TOTAL_MS);
    expect(appSetting('INGEST_DEADLINE_MS')).toBe(HANDLER_DEADLINE_MS);
  });

  it('leaves the handler time to write the tile after Overpass is done', () => {
    expect(functionTimeoutMs).toBe(600_000);
    expect(OVERPASS_DEADLINE_MS + OVERPASS_MAX_TOTAL_MS).toBeLessThan(functionTimeoutMs);
  });

  it('stops every phase, not only Overpass, before the host stops the process', () => {
    // The outer bound has to cover the Overpass worst case, or a query could start inside its
    // own deadline and finish outside the handler's — and it has to leave the host room for
    // whichever phase was mid-flight when it struck.
    expect(HANDLER_DEADLINE_MS).toBeGreaterThanOrEqual(
      OVERPASS_DEADLINE_MS + OVERPASS_MAX_TOTAL_MS,
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
 * The alert has to fire on the failure this worker actually produces. A job that fails is caught
 * by `drainJobs`, recorded on the row, and returned as a successful invocation — so a rule reading
 * only `requests` was structurally blind to it, and was, for the whole of the 2026-08-04 run.
 */
describe('the drain-failure alert, from the template', () => {
  const bicep = readFileSync(resolve(__dirname, '../../../infra/azure/ingest.bicep'), 'utf8');
  const query = /query: '([^']+)'/.exec(bicep)?.[1] ?? '';

  it('greps traces for the token the worker logs, not for its prose', () => {
    // The coupling that keeps this honest: reword the sentence and the test still passes;
    // change the token on either side alone and it does not.
    expect(query).toContain(JOB_FAILED_MARKER);
    expect(query).toContain('traces');
  });

  it('still catches an invocation the host killed, which logs nothing at all', () => {
    expect(query).toContain('ingestDrain');
    expect(query).toContain('success == false');
  });

  it('fires on a split, which returns normally and would otherwise log only "done"', () => {
    expect(query).toContain(TILE_SPLIT_MARKER);
    expect(query).toContain(SUBTREE_STUCK_MARKER);
  });

  it('exempts traces from sampling, since both trace arms are what it reads', () => {
    const host = JSON.parse(readFileSync(resolve(__dirname, '../host.json'), 'utf8')) as {
      logging: { applicationInsights: { samplingSettings: { excludedTypes?: string } } };
    };
    expect(host.logging.applicationInsights.samplingSettings.excludedTypes).toContain('Trace');
  });

  it('deploys a subdivision ceiling that survives the round trip through env', () => {
    // Asserted against a literal rather than against `subdivideMaxZoom`'s fallback: the fallback
    // is what every *invalid* input returns, so comparing the two would hold for an
    // implementation that ignored its argument entirely.
    expect(appSetting('INGEST_SUBDIVIDE_MAX_ZOOM')).toBe('11');
    expect(subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: '11' })).toBe(11);
    expect(subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: '10' })).toBe(10);
    expect(MAX_INGEST_ZOOM).toBeGreaterThanOrEqual(11);
  });

  function appSetting(name: string): string {
    const found = new RegExp(`name: '${name}'\\s*\\r?\\n\\s*value: '([^']+)'`).exec(bicep);
    if (!found) throw new Error(`${name} is not set in infra/azure/ingest.bicep`);
    return found[1]!;
  }
});
