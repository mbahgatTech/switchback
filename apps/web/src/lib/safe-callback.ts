/**
 * Reduce a `callbackUrl` to a path on this origin.
 *
 * Used by `/signin`, which both renders the value into a form and redirects an
 * already-signed-in visitor to it. Auth.js validates the destination itself before
 * redirecting, so this is defence in depth rather than the only guard — but the render and the
 * redirect are ours.
 *
 * **Parsed, not pattern-matched.** This used to be a blacklist: reject a leading `//`, reject
 * `/\`, allow everything else beginning with a slash. Browsers are more forgiving than that
 * list is long. `/%09/evil.example` is a path to a naive reader and, once the tab is stripped
 * as a C0 control during URL parsing, `//evil.example` to a browser — a scheme-relative URL,
 * and so an open redirect off the one page in the product somebody has just typed a password
 * into. A leading newline or carriage return does the same, and so does any mix of them.
 *
 * So the value is resolved against a base that cannot exist, and only the parts that are
 * definitionally same-origin are kept. Whatever a browser would have made of the input, the
 * output is a path on this site or it is `/`.
 *
 * Its own module rather than a helper inside the page, because this is the piece whose being
 * wrong is worst and it is therefore the piece that gets tested directly — the same reasoning
 * `isAllowedRedirect` is separated from its route for.
 */
const IMPOSSIBLE_BASE = 'https://x.invalid';

/**
 * A path whose first characters are encoded controls or spaces.
 *
 * `new URL` strips *raw* tabs, newlines and carriage returns as it parses, which is what turns
 * `/\t/evil.example` into `//evil.example` — and that case needs no rule here, because the
 * result stops being same-origin and the origin check catches it. What survives parsing is the
 * encoded form: `/%09/evil.example` and `/ //evil.example` (whose space is encoded on the way
 * through) both come out as genuine same-origin paths, and as they stand they are harmless.
 *
 * They are refused anyway, and this is the reason rather than superstition: each is one
 * `decodeURIComponent` away from being the scheme-relative URL again. Anything downstream that
 * unescapes this value before resolving it gets the raw control back, and with it the redirect
 * off this origin.
 *
 * Anchored at the start of the *path*, not tested against the whole string, because that is
 * the only position where the trick works — and because `%20` is ordinary everywhere else. A
 * callback to `/nearby?q=Vesper%20Peak` is a real request and must survive.
 */
const LEADING_ENCODED_CONTROL = /^\/(?:%(?:0[0-9a-f]|1[0-9a-f]|20|7f))/iu;

export function safeCallback(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith('/')) return '/';

  let url: URL;
  try {
    // A hostname that cannot resolve and a scheme we never emit: if the input turns out to
    // carry its own origin, `url.origin` stops being this one and the check below catches it.
    url = new URL(raw, IMPOSSIBLE_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== IMPOSSIBLE_BASE) return '/';
  if (LEADING_ENCODED_CONTROL.test(url.pathname)) return '/';

  const path = `${url.pathname}${url.search}${url.hash}`;
  // `new URL('//evil.example', base)` parses as an origin, not a path, so it is already gone
  // by here — this is the belt to that, and it costs one comparison.
  return path.startsWith('//') ? '/' : path;
}
