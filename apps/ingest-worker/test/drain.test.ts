/**
 * The worker's only real decision: which drain outcomes complete a message and which throw it
 * back at the broker.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DrainResult, OverpassQuerier } from '@switchback/ingest';
import { OverpassDeadlineError, withDeadline } from '@switchback/ingest';
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
    // The reconciliation the host forces: 300 s to start a query plus 240 s for that query to
    // finish is 540 s, inside the 600 s at which Consumption kills the invocation. Without it
    // the client's own budget is six attempts of 190 s plus backoff — over twenty minutes.
    let clock = 0;
    const view = withDeadline(
      { query: async () => ({ elements: [] }) },
      OVERPASS_DEADLINE_MS,
      () => clock,
    );

    await expect(view.query('[out:json];')).resolves.toBeDefined();

    clock = OVERPASS_DEADLINE_MS;
    await expect(view.query('[out:json];')).rejects.toBeInstanceOf(OverpassDeadlineError);
    expect(OVERPASS_DEADLINE_MS + 240_000).toBeLessThan(600_000);
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
