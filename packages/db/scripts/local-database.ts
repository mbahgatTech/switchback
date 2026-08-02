/**
 * Where a connection string points, for scripts that must not write to production by accident.
 * Its own module so a test can import the predicate without running the script around it.
 */

/**
 * Hosts that are provably this machine. Everything else — an IP, a pgbouncer alias, a provider
 * nobody has heard of yet — is treated as production, because the failure that matters is the
 * one where the guard has never heard of the host either. A hostname is either on this list or
 * it needs the flag; there is no third answer for the list to be out of date about.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Is this connection string one that provably cannot be production? Unparseable, empty and
 * unrecognised all answer no: the guard fails closed, so being wrong costs a flag rather than
 * 24,671 rows.
 */
export function isLocalDatabase(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `postgresql:///db?host=/var/run/postgresql` puts the host in a query parameter and leaves
  // `hostname` empty. A filesystem path there is a unix socket, which is this machine.
  const socket = parsed.searchParams.get('host');
  const host = parsed.hostname || socket || '';
  if (host.startsWith('/')) return true;
  return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
}
