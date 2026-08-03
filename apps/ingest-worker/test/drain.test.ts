/**
 * The worker's only real decision: which drain outcomes complete a message and which throw it
 * back at the broker.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DrainResult, OverpassQuerier } from '@switchback/ingest';
import { OVERPASS_MAX_TOTAL_MS, OverpassDeadlineError, withDeadline } from '@switchback/ingest';
import { OVERPASS_DEADLINE_MS, runIngestSignal } from '../src/drain';
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

    await runIngestSignal({ dedupeKey: KEY }, fakeLog(), { workerId: 'sb-1', drain, overpass });

    expect(drain).toHaveBeenCalledWith({
      limit: 1,
      derivedLimit: 0,
      dedupeKeys: [KEY],
      workerId: 'sb-1',
      deps: { overpass },
    });
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
  });

  it('leaves the handler time to write the tile after Overpass is done', () => {
    expect(functionTimeoutMs).toBe(600_000);
    expect(OVERPASS_DEADLINE_MS + OVERPASS_MAX_TOTAL_MS).toBeLessThan(functionTimeoutMs);
  });

  it('takes one message at a time, which is what makes the two budgets additive', () => {
    // With two messages in one process a query can wait for a concurrency slot, and that wait
    // is charged to neither budget — the sum above would stop bounding the invocation.
    expect(host.extensions.serviceBus.maxConcurrentCalls).toBe(1);
  });
});
