import { describe, expect, it } from 'vitest';
import { safeCallback } from '../src/lib/safe-callback';

/**
 * The open-redirect guard on `/signin` — the page a reader has just typed a password into, and
 * the one every protected route bounces to with a `callbackUrl` of its own.
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
     * Every string here begins with a slash and looks like a path; a browser resolving it lands
     * on `evil.example`. Tab, newline and carriage return are stripped as C0 controls during URL
     * parsing, and Next decodes the query string once, so `%2F%09%2Fevil.example` arrives raw.
     * The backslashes are the same trick against the `\`→`/` normalisation special schemes require.
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
    // These survive URL parsing and are harmless where they stand — refused because they stop
    // being harmless the moment anything unescapes them before resolving.
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
    // Only the leading position is the trick; a place name in a query is a real callback.
    expect(safeCallback('/nearby?q=Vesper%20Peak')).toBe('/nearby?q=Vesper%20Peak');
    expect(safeCallback('/lists/my%20list')).toBe('/lists/my%20list');
  });

  it('never returns something a browser would read as scheme-relative', () => {
    // The property rather than the list, so a case this file has not thought of still fails.
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
