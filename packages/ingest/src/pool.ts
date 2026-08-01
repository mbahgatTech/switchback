/**
 * Bounded concurrency for the ingest: `forEachConcurrent` bounds one loop, `Gate` bounds a
 * resource across every loop in the process.
 */

/**
 * Apply `run` to every item, with at most `concurrency` calls outstanding.
 *
 * A shared cursor rather than chunked batches: item cost varies by orders of magnitude within
 * one list, and a batch is only as fast as its slowest member. `cursor++` needs no lock — no
 * `await` sits between the read and the write.
 *
 * Rejections are not caught. A caller wanting per-item isolation puts its own `try` in the
 * body, since only the caller knows what a failed item costs.
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

  // No more workers than there is work, and never fewer than one. An empty list gives zero,
  // which is correct: `Promise.all([])` resolves and nothing runs.
  const workers = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * A counting semaphore for a ceiling that has to hold across separate loops: three drains
 * each politely running six at a time are eighteen against the resource. FIFO, so a long
 * tile's trails do not starve behind a stream of short ones while holding a job claim.
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
   * Run `body` holding one permit, returned however `body` ends. The `finally` is the whole
   * contract: a body that throws must not leak the gate shut and stop the process's ingest.
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
