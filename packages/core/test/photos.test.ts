import { describe, expect, it } from 'vitest';
import { exifCoordinate, formatBytes, parseExifDateTime } from '../src/photos';

/**
 * The judgements both clients make about a photograph's metadata. Tested here as well as
 * through `apps/web/test/exif.test.ts`, which drives them from a synthesised JPEG: iOS reaches
 * the same two functions from a Core Graphics dictionary, and that path is otherwise uncovered.
 */

describe('parseExifDateTime', () => {
  it("reads EXIF's colon-separated date, which no Date constructor accepts", () => {
    const date = parseExifDateTime('2024:09:14 07:32:10', null);
    expect(date?.toISOString()).toBe('2024-09-14T07:32:10.000Z');
  });

  it('applies an offset tag when there is one', () => {
    const date = parseExifDateTime('2024:09:14 07:32:10', '+02:00');
    expect(date?.toISOString()).toBe('2024-09-14T05:32:10.000Z');
  });

  it('reads a missing offset as UTC rather than guessing the uploader’s zone', () => {
    // Shifting by the *uploading* device's zone would move a photograph taken in Nepal and
    // uploaded in Seattle.
    expect(parseExifDateTime('2024:09:14 07:32:10', null)?.getUTCHours()).toBe(7);
  });

  it('ignores a malformed offset instead of producing an invalid date', () => {
    expect(parseExifDateTime('2024:09:14 07:32:10', 'nonsense')?.toISOString()).toBe(
      '2024-09-14T07:32:10.000Z',
    );
  });

  it('accepts the ISO-style T separator some writers emit', () => {
    expect(parseExifDateTime('2024:09:14T07:32:10', null)).not.toBeNull();
  });

  it('refuses a camera with a dead clock', () => {
    // 1980 is a dead coin cell; the epoch is a phone that has never seen a signal.
    expect(parseExifDateTime('1980:01:01 00:00:00', null)).toBeNull();
    expect(parseExifDateTime('1970:01:01 00:00:00', null)).toBeNull();
  });

  it('refuses a date in the future', () => {
    const year = new Date().getUTCFullYear() + 1;
    expect(parseExifDateTime(`${String(year)}:01:01 12:00:00`, null)).toBeNull();
  });

  it('allows a little slack for a clock that is merely wrong', () => {
    // A phone a few hours ahead of true is common; refusing it would throw away most of a
    // day's photographs on the wrong side of a date line.
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const [ymd = '', rest = ''] = soon.split('T');
    const stamp = `${ymd.replace(/-/gu, ':')} ${rest.slice(0, 8)}`;
    expect(parseExifDateTime(stamp, null)).not.toBeNull();
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseExifDateTime(null, null)).toBeNull();
    expect(parseExifDateTime('', null)).toBeNull();
    expect(parseExifDateTime('last Tuesday', null)).toBeNull();
    expect(parseExifDateTime('2024:13:45 99:99:99', null)).toBeNull();
  });
});

describe('exifCoordinate', () => {
  it('keeps a northern, eastern fix as it is', () => {
    expect(exifCoordinate(48.0221, 'N', 11.5819, 'E')).toEqual({ lat: 48.0221, lng: 11.5819 });
  });

  it('puts a southern photograph in the south', () => {
    // Forgetting the ref tag is the classic bug: Aoraki filed 43° north, in Bulgaria.
    expect(exifCoordinate(43.5949, 'S', 170.1417, 'E')).toEqual({
      lat: -43.5949,
      lng: 170.1417,
    });
  });

  it('puts a western photograph in the west', () => {
    expect(exifCoordinate(48.0221, 'N', 121.4519, 'W')).toEqual({
      lat: 48.0221,
      lng: -121.4519,
    });
  });

  it('reads the ref tag case- and whitespace-insensitively', () => {
    // A JPEG's own bytes are NUL-padded and occasionally lower case, unlike Core Graphics'.
    expect(exifCoordinate(43.5949, ' s ', 170.1417, 'e')?.lat).toBe(-43.5949);
  });

  it('treats a missing ref as the northern and eastern hemispheres', () => {
    expect(exifCoordinate(48.0221, null, 11.5819, null)).toEqual({
      lat: 48.0221,
      lng: 11.5819,
    });
  });

  it('refuses half a fix', () => {
    // One coordinate alone places the photograph on the prime meridian, which is a more
    // confident kind of wrong than placing it nowhere.
    expect(exifCoordinate(48.0221, 'N', null, null)).toBeNull();
    expect(exifCoordinate(null, null, 11.5819, 'E')).toBeNull();
  });

  it('refuses Null Island, which is what a chip with no fix reports', () => {
    expect(exifCoordinate(0, 'N', 0, 'E')).toBeNull();
    expect(exifCoordinate(0.00002, 'N', 0.00001, 'E')).toBeNull();
  });

  it('keeps a real fix that happens to be near the equator', () => {
    expect(exifCoordinate(0.3476, 'S', 32.5825, 'E')).toEqual({ lat: -0.3476, lng: 32.5825 });
  });

  it('refuses an angle outside the globe', () => {
    expect(exifCoordinate(91, 'N', 11.5819, 'E')).toBeNull();
    expect(exifCoordinate(48.0221, 'N', 181, 'E')).toBeNull();
    expect(exifCoordinate(Number.NaN, 'N', 11.5819, 'E')).toBeNull();
    expect(exifCoordinate(48.0221, 'N', Number.POSITIVE_INFINITY, 'E')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('names a size the way a person would', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 kB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    // "11 MB" reads as a size; "10.7 MB" reads as a measurement, which is the wrong register
    // for a limit somebody has just exceeded.
    expect(formatBytes(11.2 * 1024 * 1024)).toBe('11 MB');
  });
});
