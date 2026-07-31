import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromOurOwnOrigin } from '../app/api/auth/mobile/_binding';

/**
 * Where the `Sec-Fetch-Site` guard may stand, and where it may not.
 *
 * `GET /api/auth/mobile/complete` is a redirect target. The browser arrives there at the end
 * of `/signin` → `login.microsoftonline.com` → `/api/auth/callback/microsoft-entra-id` → 302,
 * and `Sec-Fetch-Site` is recomputed at every hop of that chain against the whole list of URLs
 * in it. One cross-site URL anywhere in the list and the header reads `cross-site` for the
 * rest of the chain, however same-origin the final hop is. A guard there refused every
 * first-time sign-in on a new device — after the reader had already given Microsoft their
 * password and their second factor — and did it invisibly, because the already-signed-in path
 * arrives as `none`, `none` survives redirects, and that is the path anyone checking by hand
 * exercises.
 *
 * There is no route-level test that can drive the real thing here: the handler needs Prisma
 * and an Auth.js session. So what is pinned instead is the placement — the guard is on the
 * POST, which is one hop from a form on a page this route rendered, and not on the GET — and
 * the predicate's own semantics, which nothing else covers.
 */
/*
 * Normalised to LF at read time, because the search below is for a literal `\n}\n`.
 *
 * The repository has no `.gitattributes` and Windows checkouts run `core.autocrlf=true`, so
 * this file arrives with 279 CRLF line endings and not one bare LF. `indexOf('\n}\n')` then
 * returns -1, `end` never exceeds `start`, and all four handler-based tests fail — on a branch
 * where the security property they pin is actually satisfied. Green on Linux CI, red on every
 * Windows clone, which is the worst way for a security test to fail: it teaches the person who
 * sees it that this file is unreliable rather than that the code is wrong.
 */
const ROUTE = readFileSync(
  fileURLToPath(new URL('../app/api/auth/mobile/complete/route.ts', import.meta.url)),
  'utf8',
).replace(/\r\n/gu, '\n');

/** The source of one exported handler, from its `export` to the next top-level `}`. */
function handler(name: 'GET' | 'POST'): string {
  const start = ROUTE.indexOf(`export async function ${name}(`);
  expect(start, `${name} handler not found`).toBeGreaterThan(-1);
  const end = ROUTE.indexOf('\n}\n', start);
  expect(end, `${name} handler has no end`).toBeGreaterThan(start);
  return ROUTE.slice(start, end);
}

describe('the origin guard on /api/auth/mobile/complete', () => {
  it('does not gate the GET, which is where Entra sends the browser back', () => {
    expect(handler('GET')).not.toMatch(/fromOurOwnOrigin/u);
  });

  it('gates the POST, which our own interstitial sends in one hop', () => {
    expect(handler('POST')).toMatch(/if \(!fromOurOwnOrigin\(request\)\)/u);
  });

  it('still reads the row on the GET, so a doomed sign-in fails before the button', () => {
    // The guard came off; the read did not. Failing after somebody has pressed "sign in on
    // that device" is worse than failing before, and this is the only thing that makes the
    // question on the page answerable — it is where the device name comes from.
    expect(handler('GET')).toMatch(/prisma\.mobileAuthRequest\.findUnique/u);
  });

  it('mints nothing on the GET', () => {
    // The whole reason dropping the header check costs nothing: this leg has no credential
    // to hand out. `authorizeAuthRequest` is the thing that mints, and it is POST-only.
    expect(handler('GET')).not.toMatch(/authorizeAuthRequest/u);
    expect(handler('POST')).toMatch(/authorizeAuthRequest/u);
  });
});

describe('fromOurOwnOrigin', () => {
  const withHeader = (value: string | null): Request =>
    new Request('https://switchback.example/api/auth/mobile/complete', {
      method: 'POST',
      ...(value === null ? {} : { headers: { 'sec-fetch-site': value } }),
    });

  it('admits our own form and a browser-initiated navigation', () => {
    expect(fromOurOwnOrigin(withHeader('same-origin'))).toBe(true);
    expect(fromOurOwnOrigin(withHeader('none'))).toBe(true);
  });

  it('admits a request with no header, which is every non-browser client', () => {
    expect(fromOurOwnOrigin(withHeader(null))).toBe(true);
  });

  it('refuses cross-site and a sibling subdomain', () => {
    // `same-site` is the sibling-subdomain case: it cannot read the `HttpOnly` CSRF cookie,
    // but it is not us either.
    expect(fromOurOwnOrigin(withHeader('cross-site'))).toBe(false);
    expect(fromOurOwnOrigin(withHeader('same-site'))).toBe(false);
  });

  it('refuses a value it has never heard of rather than guessing', () => {
    expect(fromOurOwnOrigin(withHeader('cross-origin'))).toBe(false);
    expect(fromOurOwnOrigin(withHeader(''))).toBe(false);
  });
});
