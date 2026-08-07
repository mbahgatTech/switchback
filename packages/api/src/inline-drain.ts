/**
 * One inline drain at a time per process, with everything asked for while it runs coalesced
 * into the next one. Pure scheduling — the drain itself is injected.
 */

/**
 * Units of work one follow-up may carry. A viewport contributes at most a dozen tile keys, so
 * the ceiling is a burst of concurrent readers rather than one greedy request; past it the
 * surplus is left to the cron, whose claim is unscoped and reaches it anyway. A caller whose
 * keys land past the cap still settles with the pass — it just does not carry them.
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
 * single extra claim, and bounds the wait across polls rather than within one pass: the
 * follow-up claims `Math.min(keys, MAX_INLINE_DRAIN)` jobs by `priority DESC, runAfter ASC`, so
 * a late key is asked for immediately and claimed once it is among the oldest few.
 *
 * Serialised rather than parallel for the reason the guard existed: two drains do not race —
 * `claimJobs` claims under `FOR UPDATE SKIP LOCKED` — but the Overpass client caps itself at two
 * concurrent requests, so a second drain alongside the first only piles claimed work behind it
 * and sinks the tile someone is waiting on, with nothing reporting an error.
 *
 * **What this costs, because it is not free and is not visible in a diff.** The guard it replaces
 * returned before `ctx.waitUntil`, so a poll arriving mid-drain registered nothing. This returns a
 * promise whenever there is work, so every such poll registers an `after()` callback and holds its
 * invocation until the follow-up finishes. Driving this module with one pass in flight and the
 * explore map's 2.5 s poll across a 60 s pass gives **25 held-open invocations against 1**. That is
 * the price of the property above and it is not removable by handing only the first joiner a
 * promise: `after()` budgets are per invocation, so the later callers are what keeps the follow-up
 * alive long enough to finish. Watch it if the poll interval drops or a pass gets slower.
 *
 * A caller waits for the pass carrying its own keys and no further: at most one pass ahead of its
 * own, so a steady stream of requests cannot hold any one response open indefinitely. Past that
 * the platform's `waitUntil` budget bounds it, and work cut short is still queued for the cron.
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
