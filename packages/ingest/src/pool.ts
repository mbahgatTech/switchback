/**
 * Bounded concurrency for the ingest, in two shapes.
 *
 * Every expensive loop in the ingest has the same shape: a few hundred items, each one
 * mostly waiting — on Overpass, on a terrain tile over HTTP, on a transaction's worth of
 * round-trips to Postgres. Done one at a time that is minutes of a process doing nothing;
 * done all at once it is a thundering herd against whichever of those is scarcest. This is
 * the middle, in one place, so the concurrency ceiling is a number a caller chooses rather
 * than a property of how a particular loop happens to be written.
 *
 * `forEachConcurrent` bounds one loop. `Gate` bounds a resource across every loop in the
 * process, which is a different question and turns out to be the one that matters when more
 * than one drain is running.
 */

/**
 * Apply `run` to every item, with at most `concurrency` calls outstanding.
 *
 * A shared cursor rather than chunked batches. Item cost varies by orders of magnitude
 * within one list — a 40 m staircase and a 60 km ridge traverse are both trails — and a
 * batch is only as fast as its slowest member, so fixed batches spend most of their time
 * with every worker but one idle. Workers pulling from a cursor stay busy until the list
 * is done.
 *
 * `cursor++` needs no lock. It is a read and a write with no `await` between them, and
 * JavaScript does not preempt inside a synchronous expression, so two workers cannot come
 * away with the same index.
 *
 * Rejections are not caught here. A caller that wants per-item isolation puts its own
 * `try` in the body, which is both the honest place for it — only the caller knows what a
 * failed item costs — and the reason this helper stays this small. `Promise.all` means the
 * first uncaught rejection is what the caller sees, and in-flight work is left to settle.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await run(items[index]!, index);
    }
  };

  // No more workers than there is work, and never fewer than one — `Math.min` with an empty
  // list gives zero, which is correct: `Promise.all([])` resolves and nothing runs.
  const workers = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * A counting semaphore, for a ceiling that has to hold across separate loops.
 *
 * `forEachConcurrent` bounds one call. That is the right shape for a ceiling that exists
 * because a list is long, and the wrong one for a ceiling that exists because a resource is
 * finite — three drains each politely running six at a time are eighteen at a time against
 * the resource, and each one is individually well behaved. This is the ceiling the resource
 * sees: a module-level gate, shared by every caller in the process, whatever loop they are
 * running inside.
 *
 * FIFO, because the alternative is a long tile's trails starving behind a stream of short
 * ones and a job that never finishes claiming a lock the whole time.
 */
export class Gate {
  private free: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.free = Math.max(1, Math.floor(permits));
  }

  /** Permits not currently held. Exposed for tests and logging, not for deciding anything. */
  get available(): number {
    return this.free;
  }

  /**
   * Run `body` holding one permit, and give it back however `body` ends.
   *
   * The `finally` is the whole contract. A body that throws still returns its permit, so a
   * tile whose trails fail cannot leak the gate shut and take the process's remaining ingest
   * with it — which is the failure this class would otherwise introduce, and a worse one than
   * the contention it exists to prevent.
   */
  async run<T>(body: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.queue.push(resolve));

    try {
      return await body();
    } finally {
      const next = this.queue.shift();
      // Hand the permit straight to the next waiter rather than returning it to the count.
      // Incrementing and then resolving would let a caller arriving in between take it.
      if (next) next();
      else this.free += 1;
    }
  }
}
