import { describe, expect, it } from 'vitest';
import { createInlineDrain, MAX_PENDING_KEYS } from '../src/inline-drain';

/**
 * The scheduler behind `kickIngest`. A drain that is dropped because another one is running is
 * a tile that never arrives for the reader who asked for it.
 */

/** A drain that finishes when the test says so, recording the keys of every pass. */
function controllable() {
  const passes: string[][] = [];
  const finishers: Array<(error?: Error) => void> = [];

  const run = (keys: readonly string[]) => {
    passes.push([...keys]);
    return new Promise<void>((resolve, reject) => {
      finishers.push((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  /** Finish pass `index`, then let every continuation it releases run to quiescence. */
  const finish = async (index: number, error?: Error) => {
    finishers[index]!(error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { passes, finish, run };
}

describe('inline drain scheduling', () => {
  it('drains what a second reader asked for while the first was running', async () => {
    const { passes, finish, run } = controllable();
    const drain = createInlineDrain(run);

    void drain.request(['ingest_tile:a']);
    const waiting = drain.request(['ingest_tile:b']);
    expect(passes).toEqual([['ingest_tile:a']]);

    await finish(0);

    // The second reader's tile is claimed by a pass of its own rather than left for the cron.
    expect(passes).toEqual([['ingest_tile:a'], ['ingest_tile:b']]);
    expect(waiting).not.toBeNull();
  });

  it('settles a waiting reader only once its own pass has finished', async () => {
    const { finish, run } = controllable();
    const drain = createInlineDrain(run);

    void drain.request(['ingest_tile:a']);
    const waiting = drain.request(['ingest_tile:b']);
    let settled = false;
    void waiting?.then(() => {
      settled = true;
    });

    await finish(0);
    expect(settled, 'settled while the second pass was still running').toBe(false);

    await finish(1);
    expect(settled).toBe(true);
  });

  it('runs one pass at a time, so two drains never share the Overpass client', async () => {
    const { passes, finish, run } = controllable();
    const drain = createInlineDrain(run);

    void drain.request(['ingest_tile:a']);
    void drain.request(['ingest_tile:b']);
    void drain.request(['ingest_tile:c']);
    expect(passes).toHaveLength(1);

    await finish(0);
    // Both waiting readers coalesce into the single follow-up rather than queueing two.
    expect(passes).toEqual([['ingest_tile:a'], ['ingest_tile:b', 'ingest_tile:c']]);

    await finish(1);
    expect(passes).toHaveLength(2);
  });

  it('carries a failed pass no further than its own keys', async () => {
    const { passes, finish, run } = controllable();
    const drain = createInlineDrain(run);

    const first = drain.request(['ingest_tile:a']);
    void drain.request(['ingest_tile:b']);

    await finish(0, new Error('overpass refused'));

    // A rejection must neither escape to the caller nor stop the reader behind it.
    await expect(first).resolves.toBeUndefined();
    expect(passes).toEqual([['ingest_tile:a'], ['ingest_tile:b']]);
  });

  it('asks for nothing when there is nothing queued', () => {
    const { passes, run } = controllable();
    const drain = createInlineDrain(run);

    expect(drain.request([])).toBeNull();
    expect(passes).toEqual([]);
  });

  it('bounds the follow-up, so a burst cannot grow the claim without limit', async () => {
    const { passes, finish, run } = controllable();
    const drain = createInlineDrain(run);

    void drain.request(['ingest_tile:running']);
    for (let i = 0; i < MAX_PENDING_KEYS + 50; i += 1) {
      void drain.request([`ingest_tile:${String(i)}`]);
    }

    await finish(0);
    expect(passes[1]).toHaveLength(MAX_PENDING_KEYS);
  });

  it('starts a fresh pass once the queue has drained out', async () => {
    const { passes, finish, run } = controllable();
    const drain = createInlineDrain(run);

    void drain.request(['ingest_tile:a']);
    await finish(0);
    expect(passes).toHaveLength(1);

    void drain.request(['ingest_tile:b']);
    expect(passes).toEqual([['ingest_tile:a'], ['ingest_tile:b']]);
  });
});
