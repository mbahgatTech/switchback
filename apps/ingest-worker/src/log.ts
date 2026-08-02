/** The subset of `InvocationContext` this worker uses, so the core is testable without a host. */
export interface WorkerLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
