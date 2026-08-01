import { describe, expect, it } from 'vitest';
import { safeCallback } from '../src/lib/safe-callback';

/**
 * The open-redirect guard on `/signin`.
 *
 * This is the page a reader has just typed a password into — or is about to hand to Microsoft
 * — so a redirect off this origin from here is worth more to an attacker than the same bug
 * anywhere else in the product. It is also the page most likely to be sent as a link, since
 * every protected route bounces here with a `callbackUrl` of its own.
 *
 * The guard it replaced was a blacklist of two prefixes. Everything under "browsers are more
 * forgiving than a blacklist is long" below is a string that guard let through.
 */
describe('safeCallback', () => {
  it('keeps an ordinary same-origin path, with its query and fragment', () => {
    expect(safeCallback('/lists')).toBe('/lists');
    expect(safeCallback('/trails/vesper-peak?from=map')).toBe('/trails/vesper-peak?from=map');
    expect(safeCallback('/nearby#results')).toBe('/nearby#results');
    expect(safeCallback('/api/auth/mobile/complete?request=abc')).toBe(
      '/api/auth/mobile/complete?request=abc',
    );
  });

  it('takes the first when Next hands it a repeated parameter', () => {
    // `?callbackUrl=/lists&callbackUrl=//evil.example` arrives as an array. Reading the last
    // one, or joining them, would let a second copy override a first that looked fine.
    expect(safeCallback(['/lists', '//evil.example'])).toBe('/lists');
    expect(safeCallback(['//evil.example', '/lists'])).toBe('/');
  });

  it('falls back to the front page for anything that is not a path', () => {
    for (const value of [undefined, '', 'lists', 'https://evil.example/steal', 'javascript:1']) {
      expect(safeCallback(value), String(value)).toBe('/');
    }
  });

  it('refuses a URL wearing a path as a disguise', () => {
    /*
     * Browsers are more forgiving than a blacklist is long. Every string here begins with a
     * slash and looks like a path; a browser resolving it lands on `evil.example`.
     *
     * The raw control characters are the ones that got through: tab, newline and carriage
     * return are stripped as C0 controls during URL parsing, so `/\t/evil.example` becomes
     * `//evil.example`, a scheme-relative URL. Next decodes the query string once, so
     * `?callbackUrl=%2F%09%2Fevil.example` arrives here in exactly that raw form. The
     * backslashes are the same trick against a parser that normalises `\` to `/`, which the
     * URL standard requires for special schemes.
     */
    for (const hostile of [
      '//evil.example',
      '//evil.example/steal',
      '/\\evil.example',
      '/\\\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\n//evil.example',
      '/ //evil.example',
      '/\t//evil.example',
    ]) {
      expect(safeCallback(hostile), JSON.stringify(hostile)).toBe('/');
    }
  });

  it('refuses an encoded control character, one decode short of the same trick', () => {
    /*
     * `%09` and an encoded space survive URL parsing, so `/%09/evil.example` is genuinely a
     * same-origin path and is harmless where it stands. Refused because it stops being
     * harmless the moment anything unescapes it before resolving it.
     */
    for (const hostile of [
      '/%09/evil.example',
      '/%0A/evil.example',
      '/%0d%0a//evil.example',
      '/%20//evil.example',
    ]) {
      expect(safeCallback(hostile), hostile).toBe('/');
    }
  });

  it('leaves an encoded space alone where it is ordinary', () => {
    // Only the leading position is the trick. A place name in a query is a real callback and
    // a rule that banned `%20` outright would break it.
    expect(safeCallback('/nearby?q=Vesper%20Peak')).toBe('/nearby?q=Vesper%20Peak');
    expect(safeCallback('/lists/my%20list')).toBe('/lists/my%20list');
  });

  it('never returns something a browser would read as scheme-relative', () => {
    // The property, rather than the list: whatever comes out is resolved against a second
    // origin, and it must still be that origin. A case this file has not thought of fails
    // here even if it is not in the list above.
    for (const value of [
      '/lists',
      '//evil.example',
      '/%09/evil.example',
      '/\\evil.example',
      '/\r\n//evil.example',
      '/trails/a?b=c#d',
    ]) {
      expect(new URL(safeCallback(value), 'https://y.invalid').origin).toBe('https://y.invalid');
    }
  });
});
