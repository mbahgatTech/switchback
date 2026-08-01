/**
 * Reduce a `callbackUrl` to a path on this origin, for `/signin`. Parsed rather than
 * pattern-matched: `/%09/evil.example` reads as a path but becomes `//evil.example` once the tab
 * is stripped as a C0 control — an open redirect off the page somebody just typed a password
 * into. Resolving against an impossible base and keeping only definitionally same-origin parts
 * means the output is a path on this site or it is `/`.
 */
const IMPOSSIBLE_BASE = 'https://x.invalid';

/**
 * A path starting with an *encoded* control or space. Raw ones are stripped during parsing and
 * caught by the origin check; these survive as genuine same-origin paths and are harmless as they
 * stand — but each is one `decodeURIComponent` away from being scheme-relative again. Anchored at
 * the start of the path only, because `%20` is ordinary elsewhere: `/nearby?q=Vesper%20Peak`.
 */
const LEADING_ENCODED_CONTROL = /^\/(?:%(?:0[0-9a-f]|1[0-9a-f]|20|7f))/iu;

export function safeCallback(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith('/')) return '/';

  let url: URL;
  try {
    // A hostname that cannot resolve and a scheme we never emit: if the input carries its own
    // origin, `url.origin` stops being this one and the check below catches it.
    url = new URL(raw, IMPOSSIBLE_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== IMPOSSIBLE_BASE) return '/';
  if (LEADING_ENCODED_CONTROL.test(url.pathname)) return '/';

  const path = `${url.pathname}${url.search}${url.hash}`;
  // Belt to the origin check above, at the cost of one comparison.
  return path.startsWith('//') ? '/' : path;
}
