/**
 * The `ingestPump` timer handler, driven through the function the host registers.
 *
 * `runPump`'s band is an optional parameter, so asserting on `runPump` alone still passes when the
 * argument is dropped at the call site — and dropping it turns the brake from "reclaimed leases
 * only" into "publish the whole runnable head".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECLAIM_PRIORITY } from '@switchback/ingest';
import type * as DbModule from '@switchback/db';
import type * as IngestModule from '@switchback/ingest';
import type * as PumpModule from '../src/pump';

type Handler = (timer: unknown, context: unknown) => Promise<void>;

const stub = vi.hoisted(() => ({
  registered: undefined as Handler | undefined,
  runPump: vi.fn(async () => ({ published: 0 })),
  sweepQueue: vi.fn(async () => ({
    requeued: 0,
    retired: 0,
    unsplit: [],
    unwedged: [],
    revived: [],
    abandoned: [],
  })),
  pruneFinishedJobs: vi.fn(async () => 0),
  reportQueueHealth: vi.fn(async () => {}),
  reconcileDeadLetters: vi.fn(async () => ({ runnable: [], terminal: [], unreadable: [] })),
}));

vi.mock('@azure/functions', () => ({
  app: {
    timer: (_name: string, options: { handler: Handler }) => {
      stub.registered = options.handler;
    },
  },
}));

vi.mock('@switchback/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  backgroundPrisma: {},
}));

vi.mock('@switchback/ingest', async (importOriginal) => ({
  ...(await importOriginal<typeof IngestModule>()),
  sweepQueue: stub.sweepQueue,
  pruneFinishedJobs: stub.pruneFinishedJobs,
}));

vi.mock('../src/health', () => ({ reportQueueHealth: stub.reportQueueHealth }));

vi.mock('../src/dead-letter', () => ({ reconcileDeadLetters: stub.reconcileDeadLetters }));

vi.mock('../src/pump', async (importOriginal) => ({
  ...(await importOriginal<typeof PumpModule>()),
  runPump: stub.runPump,
}));

vi.mock('../src/service-bus', () => ({
  serviceBusQueue: () => ({}),
  deadLetterQueue: () => ({}),
}));

// Importing registers the timer, which is how the handler under test is obtained.
import '../src/functions/pump';

const context = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** The band `refill` narrows to, or `undefined` when it narrows to nothing. */
async function bandPassedToPump(brake: string | undefined): Promise<number | undefined> {
  if (brake === undefined) delete process.env.INGEST_PUMP_ENABLED;
  else process.env.INGEST_PUMP_ENABLED = brake;

  const handler = stub.registered;
  if (!handler) throw new Error('ingestPump registered no handler');
  await handler({}, context);

  const call = stub.runPump.mock.calls.at(-1) as unknown[] | undefined;
  if (!call) throw new Error('the handler did not run the pump');
  return call[5] as number | undefined;
}

describe('the ingestPump handler', () => {
  beforeEach(() => {
    stub.runPump.mockClear();
  });

  it('narrows the pump to reclaimed leases while the brake is on', async () => {
    expect(await bandPassedToPump('false')).toBe(RECLAIM_PRIORITY);
  });

  it('narrows nothing while the brake is off', async () => {
    // The same call with no band: an unbraked tick reads the whole runnable head, which is what
    // makes the assertion above a statement about the brake rather than about `runPump`'s default.
    expect(await bandPassedToPump('true')).toBeUndefined();
  });

  it('reclaims expired leases whichever way the brake is set', async () => {
    stub.sweepQueue.mockClear();
    await bandPassedToPump('false');

    // The sweep runs ahead of the brake: a stopped pump that also stopped reclaiming would leave
    // every lease a killed invocation held stuck for as long as the brake was on.
    expect(stub.sweepQueue).toHaveBeenCalledTimes(1);
  });

  it('drains the dead-letter queue whichever way the brake is set', async () => {
    stub.reconcileDeadLetters.mockClear();
    await bandPassedToPump('false');

    // Same argument, and a stronger one: the brake is pulled when something is wrong, which is
    // when the queue is likeliest to be holding messages nobody is going to look at.
    expect(stub.reconcileDeadLetters).toHaveBeenCalledTimes(1);
  });

  it('runs both repairs with no request having reached the estate', async () => {
    /*
     * The point of the timer. Nothing in this test publishes a signal, opens a map or calls the
     * API — the handler is invoked with a timer and a context, which is what the host does on a
     * schedule — and both repairs still run.
     */
    stub.sweepQueue.mockClear();
    stub.reconcileDeadLetters.mockClear();

    const handler = stub.registered;
    if (!handler) throw new Error('ingestPump registered no handler');
    await handler({}, context);

    expect(stub.sweepQueue).toHaveBeenCalledTimes(1);
    expect(stub.reconcileDeadLetters).toHaveBeenCalledTimes(1);
  });

  it('drains the dead-letter queue even when the database sweep throws', async () => {
    // Separate catches: the broker and Postgres fail for unrelated reasons, and one shared catch
    // would let an unreachable database leave the queue filling.
    stub.reconcileDeadLetters.mockClear();
    stub.sweepQueue.mockRejectedValueOnce(new Error('postgres is gone'));

    await bandPassedToPump(undefined);

    expect(stub.reconcileDeadLetters).toHaveBeenCalledTimes(1);
  });
});
