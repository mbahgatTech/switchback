import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromOurOwnOrigin } from '../app/api/auth/mobile/_binding';

/**
 * Where the `Sec-Fetch-Site` guard may stand, and where it may not. `GET /complete` is a redirect
 * target whose chain runs through Microsoft, so the header reads `cross-site` there; `POST
 * /complete` and `GET /start` are single hops. The handler needs Prisma and an Auth.js session,
 * so what is pinned is the guard's placement and the predicate's own semantics.
 */
/*
 * Normalised to LF because the search below is for a literal `\n}\n`. Windows checkouts run
 * `core.autocrlf=true` and this file arrives with no bare LF at all — without this the four
 * handler tests fail on every Windows clone while passing on CI.
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
    expect(handler('GET')).toMatch(/prisma\.mobileAuthRequest\.findUnique/u);
  });

  it('mints nothing on the GET', () => {
    // The call, not the name: the GET's comments cite the function, and a bare word match
    // would read that as a call.
    expect(handler('GET')).not.toMatch(/authorizeAuthRequest\(/u);
    expect(handler('POST')).toMatch(/authorizeAuthRequest\(/u);
  });

  it('compares the binding on the GET rather than testing it for presence', () => {
    // Same expression as `authorizeAuthRequest`, so the two legs cannot come apart.
    expect(handler('GET')).toMatch(
      /stored\.browserHash !== \(await hashToken\(readBindingSecret\(request\)\)\)/u,
    );
  });
});

/**
 * The guard that makes the ones above independent. Without it an attacker page runs the whole
 * chain in the victim's browser — their challenge, a matching binding cookie, a real session, an
 * honest CSRF token — leaving only the consent click. `/start` is the first hop, so the header
 * describes what really started the navigation.
 */
describe('the origin guard on /api/auth/mobile/start', () => {
  it('gates the GET, which is the first hop and not a redirect target', () => {
    expect(START).toMatch(/if \(!fromOurOwnOrigin\(request\)\)/u);
  });

  it('refuses before it writes a row', () => {
    // A guard after `startAuthRequest` would still create the row and still set the cookie.
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
    // A concession, not a covered case: plain-HTTP development builds and every supported iOS
    // below 16.4 arrive header-less, and refusing them 403s the first hop of sign-in.
    expect(fromOurOwnOrigin(withHeader(null))).toBe(true);
  });

  it('keeps the reason for that admission written down', () => {
    // Pinned so the honest version cannot be compressed back into "just a non-browser client".
    expect(BINDING).toMatch(/Safari 16\.4/u);
    expect(BINDING).toMatch(/not potentially trustworthy/u);
  });

  it('refuses cross-site and a sibling subdomain', () => {
    // `same-site` is the sibling subdomain: it cannot read the `HttpOnly` CSRF cookie, but it
    // is not us either.
    expect(fromOurOwnOrigin(withHeader('cross-site'))).toBe(false);
    expect(fromOurOwnOrigin(withHeader('same-site'))).toBe(false);
  });

  it('refuses a value it has never heard of rather than guessing', () => {
    expect(fromOurOwnOrigin(withHeader('cross-origin'))).toBe(false);
    expect(fromOurOwnOrigin(withHeader(''))).toBe(false);
  });
});
