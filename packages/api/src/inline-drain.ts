/**
 * One inline drain at a time per process, with everything asked for while it runs coalesced
 * into the next one. Pure scheduling — the drain itself is injected.
 */

/**
 * Units of work one follow-up may carry. A viewport contributes at most a dozen tile keys, so
 * the ceiling is a burst of concurrent readers rather than one greedy request; past it the
 * surplus is left to the cron, whose claim is unscoped and reaches it anyway.
 */
export const MAX_PENDING_KEYS = 256;

export interface InlineDrain {
  /**
   * Drain these units of work, and settle when the pass carrying them has finished. `null`
   * when there is nothing to ask for, so there is nothing to hold a response open for.
   */
  request(keys: readonly string[]): Promise<void> | null;
}

interface Pass {
  keys: Set<string>;
  settled: Promise<void>;
  finish: () => void;
}

function newPass(keys: readonly string[]): Pass {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { keys: new Set(keys), settled, finish };
}

/**
 * Serialise inline drains and coalesce what arrives while one is running.
 *
 * A bare `if (running) return` — which is what both routers had — drops the second reader's
 * request outright. Their tiles are enqueued by `ensureCoverage` either way, so the queue stays
 * correct; what is lost is the drain that would have run them, because the pass in flight is
 * scoped to the *first* reader's tile keys and nothing looks again when it ends. That tile then
 * waits on a poll, or on the daily cron. Holding the keys and running one more pass costs a
 * single extra claim and makes the wait bounded.
 *
 * Serialised rather than parallel for the reason the guard existed: two drains do not race —
 * `claimJobs` claims under `FOR UPDATE SKIP LOCKED` — but the Overpass client caps itself at two
 * concurrent requests, so a second drain alongside the first only piles claimed work behind it
 * and sinks the tile someone is waiting on, with nothing reporting an error.
 *
 * A caller waits for the pass carrying its own keys and no further, so a steady stream of
 * requests cannot hold any one response open indefinitely.
 */
export function createInlineDrain(run: (keys: readonly string[]) => Promise<unknown>): InlineDrain {
  let running: Pass | null = null;
  let next: Pass | null = null;

  const start = (pass: Pass): void => {
    running = pass;
    void (async () => {
      try {
        await run([...pass.keys]);
      } catch {
        /* Recorded on the job row; see ingest_jobs.lastError. */
      }
      running = null;
      pass.finish();
      if (next) {
        const promoted = next;
        next = null;
        start(promoted);
      }
    })();
  };

  return {
    request(keys) {
      if (keys.length === 0) return null;

      if (!running) {
        const pass = newPass(keys);
        start(pass);
        return pass.settled;
      }

      const pending = (next ??= newPass([]));
      for (const key of keys) {
        if (pending.keys.size >= MAX_PENDING_KEYS) break;
        pending.keys.add(key);
      }
      return pending.settled;
    },
  };
}
