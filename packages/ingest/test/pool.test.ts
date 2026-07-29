import { describe, expect, it } from 'vitest';
import { Gate, forEachConcurrent } from '../src/pool';

/** A promise plus the handle to settle it, so a test can decide when an item finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('forEachConcurrent', () => {
  it('runs every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];

    await forEachConcurrent(items, 6, async (item) => {
      seen.push(item);
    });

    expect(seen).toHaveLength(items.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it('passes each item its own index', async () => {
    const pairs: Array<[string, number]> = [];

    await forEachConcurrent(['a', 'b', 'c'], 2, async (item, index) => {
      pairs.push([item, index]);
    });

    expect(pairs.sort((x, y) => x[1] - y[1])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  /**
   * The property the whole helper exists for.
   *
   * The ceiling is not our CPU, it is the scarce resources underneath — `TerrainSource`
   * caps its own fetches, and Prisma's pool is finite. A helper that quietly let a
   * fifty-item list put fifty transactions in flight would convert "fetching terrain" into
   * "waiting for a connection", which is the same wall clock with worse failure modes.
   */
  it('never exceeds the concurrency ceiling', async () => {
    let inFlight = 0;
    let peak = 0;

    await forEachConcurrent(
      Array.from({ length: 40 }, (_, i) => i),
      6,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // A macrotask, not just a microtask: enough for every other worker to reach its own
        // increment, so a broken ceiling shows up as a peak of 40 rather than by luck.
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    );

    expect(peak).toBe(6);
    expect(inFlight).toBe(0);
  });

  /**
   * A shared cursor rather than fixed batches, asserted by the case that distinguishes
   * them: one slow item among fast ones.
   *
   * With batches of two, item 1 blocks the whole second batch and only two items finish
   * before it resolves. With a cursor, the free worker keeps pulling — so everything except
   * the slow item is done while it is still outstanding.
   */
  it('keeps free workers pulling past a slow item', async () => {
    const slow = deferred();
    const done: number[] = [];
    const items = [0, 1, 2, 3, 4, 5];

    const all = forEachConcurrent(items, 2, async (item) => {
      if (item === 1) await slow.promise;
      done.push(item);
    });

    // Let every non-blocked item run to completion.
    await new Promise((r) => setTimeout(r, 5));
    expect(done.sort((a, b) => a - b)).toEqual([0, 2, 3, 4, 5]);

    slow.resolve();
    await all;
    expect(done).toHaveLength(items.length);
  });

  it('resolves without running anything for an empty list', async () => {
    let calls = 0;
    await forEachConcurrent([], 6, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('treats a concurrency below one as one', async () => {
    let inFlight = 0;
    let peak = 0;

    await forEachConcurrent([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });

    expect(peak).toBe(1);
  });

  /**
   * Rejections propagate rather than being swallowed.
   *
   * `processTile` wraps its body in a `try` so one bad trail costs its tile a single row,
   * and that is the caller's decision to make. A helper that caught on the caller's behalf
   * would make the other choice — silently finish, report success — impossible to opt out of.
   */
  it('rejects when the body throws', async () => {
    await expect(
      forEachConcurrent([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('bad trail');
      }),
    ).rejects.toThrow('bad trail');
  });
});

describe('Gate', () => {
  it('never exceeds its permits', async () => {
    const gate = new Gate(3);
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        gate.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(gate.available).toBe(3);
  });

  /**
   * The property `forEachConcurrent` cannot give us, and the reason this class exists.
   *
   * Three code paths start ingest drains and each is guarded only against starting a second
   * of its own kind, so three well-behaved six-at-a-time loops are eighteen transactions
   * against one connection pool. Two independent loops here, each obeying a ceiling of four,
   * must still be four in total — not eight.
   */
  it('holds the ceiling across separate loops', async () => {
    const gate = new Gate(4);
    let inFlight = 0;
    let peak = 0;

    const body = async (): Promise<void> => {
      await gate.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      });
    };

    const items = Array.from({ length: 12 }, (_, i) => i);
    await Promise.all([forEachConcurrent(items, 4, body), forEachConcurrent(items, 4, body)]);

    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
  });

  /**
   * A permit leaked on failure is worse than the contention the gate prevents: the ingest
   * would run one fewer commit at a time after every failed trail and eventually stop
   * entirely, while the queue kept claiming jobs and the tiles kept not filling in.
   */
  it('returns the permit when the body throws', async () => {
    const gate = new Gate(1);

    await expect(
      gate.run(async () => {
        throw new Error('trail failed');
      }),
    ).rejects.toThrow('trail failed');

    expect(gate.available).toBe(1);
    await expect(gate.run(async () => 'after')).resolves.toBe('after');
  });

  /**
   * FIFO, because the alternative starves a long tile behind a stream of short ones while
   * its job holds a claim the whole time.
   */
  it('admits waiters in the order they arrived', async () => {
    const gate = new Gate(1);
    const order: number[] = [];
    const blocker = deferred();

    const held = gate.run(() => blocker.promise);
    const waiters = [1, 2, 3].map((n) =>
      gate.run(async () => {
        order.push(n);
      }),
    );

    blocker.resolve();
    await Promise.all([held, ...waiters]);

    expect(order).toEqual([1, 2, 3]);
    expect(gate.available).toBe(1);
  });

  it('treats a permit count below one as one', async () => {
    const gate = new Gate(0);
    expect(gate.available).toBe(1);
  });

  it('returns what the body returned', async () => {
    const gate = new Gate(2);
    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });
});
