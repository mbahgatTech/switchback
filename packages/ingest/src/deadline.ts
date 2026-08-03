/**
 * The one wall clock a whole ingest handler shares. Overpass has its own budget; this is the
 * outer bound that every other phase — terrain, commits — is measured against.
 */

/** Thrown by any phase that would run past the invocation's deadline. */
export class IngestDeadlineError extends Error {
  constructor(phase: string, overrunMs: number) {
    super(`ingest deadline for this invocation passed ${Math.round(overrunMs / 1000)}s ago`);
    this.name = 'IngestDeadlineError';
    this.phase = phase;
  }

  readonly phase: string;
}

/** Throw if `at` has already passed. A no-op when there is no deadline. */
export function assertBefore(at: number | undefined, phase: string, now = Date.now()): void {
  if (at !== undefined && now >= at) throw new IngestDeadlineError(phase, now - at);
}

/**
 * How long a single request may run: its own timeout, or what is left of the deadline when
 * that is shorter. Never zero — `assertBefore` is what rejects an expired budget, and a
 * zero-millisecond `AbortSignal.timeout` aborts before the socket opens.
 */
export function requestBudgetMs(timeoutMs: number, at: number | undefined, now = Date.now()) {
  if (at === undefined) return timeoutMs;
  return Math.max(1, Math.min(timeoutMs, at - now));
}
