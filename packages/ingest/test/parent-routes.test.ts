import { describe, expect, it } from 'vitest';
import type { JobStatus, PrismaClient } from '@switchback/db';
import { startParentRouteDiscovery } from '../src/parent-routes';
import { OverpassDeadlineError, withDeadline } from '../src/overpass';
import type { OverpassElement, OverpassQuerier, OverpassResponse } from '../src/overpass';
import type { AssembledTrail } from '../src/assemble';

/** One assembled relation, reduced to the two fields this lookup reads. */
const SECTION = { osmType: 'relation', osmId: 77 } as unknown as AssembledTrail;
const WAY = { osmType: 'way', osmId: 42 } as unknown as AssembledTrail;

const PCT: OverpassElement = {
  type: 'relation',
  id: 1_225_378,
  members: [],
  tags: { type: 'superroute', name: 'Pacific Crest Trail' },
};

/** A Prisma stand-in reduced to the one table an ingest job lands in. */
function fakeDb(): { db: PrismaClient; queued: string[] } {
  const queued: string[] = [];
  const db = {
    ingestJob: {
      findMany: () => Promise.resolve([] as Array<{ dedupeKey: string; status: JobStatus }>),
      updateMany: () => Promise.resolve({ count: 0 }),
      upsert: (args: { where: { dedupeKey: string } }) => {
        queued.push(args.where.dedupeKey);
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaClient;
  return { db, queued };
}

/** A promise the test settles by hand, so the lookup can be held in flight across other work. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('startParentRouteDiscovery', () => {
  it('queues an ingest job for every named superroute the answer holds', async () => {
    const { db, queued } = fakeDb();
    const overpass = {
      query: () =>
        Promise.resolve({
          elements: [
            PCT,
            // A section container, which tiles already ingest by bbox.
            {
              type: 'relation',
              id: 9,
              members: [],
              tags: { type: 'route', name: 'PCT Section A' },
            },
            // A superroute nobody named is a superroute nobody can render.
            { type: 'relation', id: 10, members: [], tags: { type: 'superroute' } },
            { type: 'way', id: 11 },
          ] as OverpassElement[],
        }),
    };

    await startParentRouteDiscovery(db, [SECTION], { overpass }).settle();

    expect(queued).toEqual(['ingest_route:1225378']);
  });

  it('hands the query over before anything awaits its answer', async () => {
    /*
     * The whole point of the shape: the round trip is meant to spend the commit loop's wall clock,
     * which it can only do if it is in flight before the loop starts. Asserted synchronously,
     * because a query sent inside `settle()` would satisfy every other test in this file.
     */
    const { db } = fakeDb();
    const answer = deferred<OverpassResponse>();
    const sent: string[] = [];
    const overpass = {
      query: (ql: string) => {
        sent.push(ql);
        return answer.promise;
      },
    };

    const discovery = startParentRouteDiscovery(db, [SECTION], { overpass });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('relation(br)');

    answer.resolve({ elements: [] });
    await discovery.settle();
  });

  it('asks nothing at all for a tile whose trails are all ways', async () => {
    // `relation(br)` needs relation ids. A tile of standalone paths has none, and the cheapest
    // request is the one never sent.
    const { db, queued } = fakeDb();
    let queries = 0;
    const overpass = {
      query: () => {
        queries += 1;
        return Promise.resolve({ elements: [] });
      },
    };

    await startParentRouteDiscovery(db, [WAY], { overpass }).settle();

    expect(queries).toBe(0);
    expect(queued).toEqual([]);
  });

  it('settles without queueing when the lookup fails, and says so', async () => {
    const { db, queued } = fakeDb();
    const logged: string[] = [];
    const overpass = { query: () => Promise.reject(new Error('mirror said 504')) };

    await expect(
      startParentRouteDiscovery(db, [SECTION], {
        overpass,
        logger: (message) => logged.push(message),
      }).settle(),
    ).resolves.toBeUndefined();

    expect(queued).toEqual([]);
    expect(logged.join()).toContain('switchback-ingest-overpass-skipped');
  });

  it('leaves no unhandled rejection behind when the tile abandons it', async () => {
    /*
     * A tile that splits or fails returns without settling, so the lookup it started is the one
     * promise in the pipeline nobody is waiting on. An unhandled rejection there ends the worker
     * process under Node's default policy: the tile's committed trails would survive, the
     * invocation would not.
     */
    const { db } = fakeDb();
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const overpass = { query: () => Promise.reject(new OverpassDeadlineError(1_200)) };

      startParentRouteDiscovery(db, [SECTION], { overpass });
      // Node reports an unhandled rejection at the end of a macrotask, not a microtask.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(unhandled).toEqual([]);
  });

  it('sends the lookup on a tile that runs out of clock, where the serial shape sent none', async () => {
    /*
     * The one path where this asks Overpass for more than the shape it replaces. `withDeadline`
     * refuses synchronously at hand-over, so a lookup handed over after the commit loop is refused
     * on every tile whose budget the loop spent, and one handed over before it is already in
     * flight. Pinned rather than fixed: the two cannot be had at once, and a future change must be
     * able to see which one it is trading away.
     *
     * What discriminates the two shapes is the clock at hand-over and nothing else: `withDeadline`
     * reads `now()` before delegating, so an advance inside the inner querier can never reach the
     * refusal decision. The loop below is an awaited step because that is the shape it models, not
     * because a synchronous one would pass for the wrong reason — against this `withDeadline` it
     * would not. Moving the deadline check to completion time is the change that invalidates this
     * test, and it would have to rewrite it rather than quietly green it.
     */
    const deadlineAt = 1_500;

    function tile(): { overpass: OverpassQuerier; sent: string[]; clock: { now: number } } {
      const sent: string[] = [];
      const clock = { now: 1_000 };
      const inner: OverpassQuerier = {
        query: (ql: string) => {
          sent.push(ql);
          return Promise.resolve({ elements: [] });
        },
      };
      return { overpass: withDeadline(inner, deadlineAt, () => clock.now), sent, clock };
    }

    /** The commit loop, reduced to the one thing it does to this decision: it spends the budget. */
    const commitLoop = async (clock: { now: number }): Promise<void> => {
      await Promise.resolve();
      clock.now = 2_000;
    };

    const { db } = fakeDb();

    const overlapped = tile();
    const started = startParentRouteDiscovery(db, [SECTION], { overpass: overlapped.overpass });
    await commitLoop(overlapped.clock);
    await started.settle();

    const serial = tile();
    await commitLoop(serial.clock);
    await startParentRouteDiscovery(db, [SECTION], { overpass: serial.overpass }).settle();

    expect(overlapped.sent).toHaveLength(1);
    expect(serial.sent).toEqual([]);
  });

  it('takes the handler-deadline view when one is offered, and never a second client', async () => {
    // The reserve `overpass` keeps back is clock for the commit loop, which this query runs
    // beside rather than ahead of. Both are views of the one shared client.
    const { db } = fakeDb();
    const reserved: string[] = [];
    const toHandlerDeadline: string[] = [];

    const discovery = startParentRouteDiscovery(db, [SECTION], {
      overpass: {
        query: (ql: string) => {
          reserved.push(ql);
          return Promise.resolve({ elements: [] });
        },
      },
      overpassToHandlerDeadline: {
        query: (ql: string) => {
          toHandlerDeadline.push(ql);
          return Promise.resolve({ elements: [] });
        },
      },
    });

    expect(reserved).toEqual([]);
    expect(toHandlerDeadline).toHaveLength(1);
    await discovery.settle();
  });
});
