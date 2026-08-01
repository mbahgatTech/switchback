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

/** The first leg, read the same way and normalised for the same reason. */
const START = readFileSync(
  fileURLToPath(new URL('../app/api/auth/mobile/start/route.ts', import.meta.url)),
  'utf8',
).replace(/\r\n/gu, '\n');

/** The predicate's own file, for the one claim below that lives in prose rather than code. */
const BINDING = readFileSync(
  fileURLToPath(new URL('../app/api/auth/mobile/_binding.ts', import.meta.url)),
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
    //
    // The call, not the name: the GET's own comments cite the function to explain that its
    // binding check is spelled the same way, and a bare word match reads that as a call.
    expect(handler('GET')).not.toMatch(/authorizeAuthRequest\(/u);
    expect(handler('POST')).toMatch(/authorizeAuthRequest\(/u);
  });

  it('compares the binding on the GET rather than testing it for presence', () => {
    /*
     * `!readBindingSecret(request)` asks only whether a cookie is there. That let the one
     * failure the binding exists to produce — a cookie belonging to a different row — reach
     * the confirmation page: the reader pressed the button and got `wrong_browser` from the
     * POST, and an attacker-chosen device name was rendered on our own origin for a request
     * that could never mint anything. Same expression as `authorizeAuthRequest`, so the two
     * legs cannot come apart.
     */
    expect(handler('GET')).toMatch(
      /stored\.browserHash !== \(await hashToken\(readBindingSecret\(request\)\)\)/u,
    );
  });
});

/**
 * The guard that makes the ones above independent of each other.
 *
 * Every check on `/complete` can be satisfied at once if the attacker gets to choose which
 * browser runs `/start`: the row carries a challenge they picked, so they hold the verifier;
 * the 302's `Set-Cookie` is accepted by the victim's browser because a `SameSite=Lax` cookie
 * set on a top-level navigation response is; `safeCallback` preserves the `request` id through
 * `/signin`; and the confirmation POST is then honestly same-origin, with an honest CSRF token
 * and a binding cookie that genuinely matches. Three guards, all green, one consent click from
 * a sixty-day refresh token on somebody else's account.
 *
 * `/start` is the first hop of that chain — the app opens the browser at it (`none`) or one of
 * our pages links to it (`same-origin`) — so `Sec-Fetch-Site` describes the thing that really
 * started the navigation, and the redirect-chain degradation that forced the guard off
 * `GET /complete` does not apply.
 */
describe('the origin guard on /api/auth/mobile/start', () => {
  it('gates the GET, which is the first hop and not a redirect target', () => {
    expect(START).toMatch(/if \(!fromOurOwnOrigin\(request\)\)/u);
  });

  it('refuses before it writes a row', () => {
    // The point is that the attacker never gets a row bound to the victim's browser. A guard
    // after `startAuthRequest` would still create one and still set the cookie.
    const guard = START.indexOf('fromOurOwnOrigin(request)');
    const create = START.indexOf('startAuthRequest(');
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
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

  it('admits a request with no header, which is not only a non-browser client', () => {
    /*
     * The admission is deliberate and it is a concession rather than a covered case. Three
     * things arrive without `Sec-Fetch-Site`: a non-browser client, a browser on an origin
     * that is not potentially trustworthy — Fetch Metadata is only attached to secure
     * origins, so every plain-HTTP development build sends nothing — and a browser older
     * than Safari 16.4, which is every supported iOS from 15.1 up. Refusing it on `/start`
     * was proposed and refused: it 403s the first hop of sign-in on those devices and in
     * development, from a browser sheet with no navigation in it. See `fromOurOwnOrigin`.
     */
    expect(fromOurOwnOrigin(withHeader(null))).toBe(true);
  });

  it('keeps the reason for that admission written down', () => {
    /*
     * The wording this replaces justified `null` once for both callers — non-browser client,
     * plus the binding cookie and the CSRF token — and that argument only holds on
     * `POST /complete`. `GET /start` is where the cookie is minted and carries no CSRF token.
     * Pinned so the honest version cannot be quietly compressed back into the wrong one.
     */
    expect(BINDING).toMatch(/Safari 16\.4/u);
    expect(BINDING).toMatch(/not potentially trustworthy/u);
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
