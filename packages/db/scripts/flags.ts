/**
 * Command-line flags for the backfill scripts. Its own module so both read `--out` and
 * `--peaks` the same way, and so a test can check the empty case without running a script.
 */

/**
 * The value after `--flag`, or null when the flag is absent — and also when its value is. An
 * empty or missing path is absent rather than a filename: `--out` with nothing after it once
 * cost this repo 24 GB of disk, written to a file called the empty string.
 */
export function flagValue(argv: readonly string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  if (at === -1) return null;
  const value = argv[at + 1];
  return value !== undefined && value.length > 0 && !value.startsWith('--') ? value : null;
}
