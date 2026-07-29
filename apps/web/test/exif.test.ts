import { describe, expect, it } from 'vitest';
import { readExif } from '../src/lib/exif';

/**
 * The EXIF reader.
 *
 * Tested against JPEGs assembled byte by byte here rather than against a checked-in photograph,
 * because a fixture proves the parser works on one camera and a builder proves it works on the
 * format: little-endian and big-endian, values inline and values on the heap, a southern
 * hemisphere, a truncated file.
 *
 * The stakes are asymmetric and that shapes what is asserted. A missed timestamp costs a line
 * of caption. A *wrong* coordinate publishes where somebody was — so the cases that matter most
 * here are the ones where the reader must return nothing at all.
 */

// ---------------------------------------------------------------------------
// A JPEG builder
// ---------------------------------------------------------------------------

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

interface Entry {
  tag: number;
  type: number;
  count: number;
  payload: number[];
}

function u16(value: number, le: boolean): number[] {
  const bytes = [value & 0xff, (value >> 8) & 0xff];
  return le ? bytes : bytes.reverse();
}

function u32(value: number, le: boolean): number[] {
  const bytes = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  return le ? bytes : bytes.reverse();
}

/** NUL-terminated, as the EXIF ASCII type requires — the terminator is part of the count. */
function ascii(value: string): number[] {
  return [...value].map((char) => char.charCodeAt(0)).concat(0);
}

function asciiEntry(tag: number, value: string): Entry {
  const payload = ascii(value);
  return { tag, type: TYPE_ASCII, count: payload.length, payload };
}

/** Degrees, minutes, seconds as three unsigned rationals. Seconds keep two decimal places. */
function dms(degrees: number, minutes: number, seconds: number, le: boolean): number[] {
  return [
    ...u32(degrees, le),
    ...u32(1, le),
    ...u32(minutes, le),
    ...u32(1, le),
    ...u32(Math.round(seconds * 100), le),
    ...u32(100, le),
  ];
}

function entryBytes(entry: Entry, le: boolean, heap: number[], heapBase: number): number[] {
  const head = [...u16(entry.tag, le), ...u16(entry.type, le), ...u32(entry.count, le)];
  if (entry.payload.length <= 4) {
    // The inline shortcut: four bytes or fewer live in the offset field itself. A reader that
    // treats this slot as an offset unconditionally reads the hemisphere from the wrong place.
    const padded = [...entry.payload];
    while (padded.length < 4) padded.push(0);
    return [...head, ...padded];
  }
  const offset = heapBase + heap.length;
  heap.push(...entry.payload);
  if (heap.length % 2 === 1) heap.push(0);
  return [...head, ...u32(offset, le)];
}

function ifdBytes(entries: Entry[], le: boolean, heap: number[], heapBase: number): number[] {
  const out = [...u16(entries.length, le)];
  for (const entry of entries) out.push(...entryBytes(entry, le, heap, heapBase));
  return [...out, ...u32(0, le)]; // no next IFD
}

const ifdSize = (count: number): number => 2 + 12 * count + 4;

interface Gps {
  lat: readonly [number, number, number];
  latRef: string;
  lng: readonly [number, number, number];
  lngRef: string;
}

interface BuildOptions {
  littleEndian?: boolean;
  date?: string | null;
  zone?: string | null;
  gps?: Gps | null;
  /** Corrupt the TIFF magic, as a file that is not really EXIF would be. */
  badMagic?: boolean;
  /** Cut the file off partway through the TIFF block. */
  truncateTo?: number;
}

function buildTiff(options: BuildOptions): number[] {
  const le = options.littleEndian ?? true;

  const exifEntries: Entry[] = [];
  if (options.date) exifEntries.push(asciiEntry(0x9003, options.date));
  if (options.zone) exifEntries.push(asciiEntry(0x9011, options.zone));

  const gpsEntries: Entry[] = [];
  if (options.gps) {
    const { lat, latRef, lng, lngRef } = options.gps;
    gpsEntries.push(asciiEntry(0x0001, latRef));
    gpsEntries.push({
      tag: 0x0002,
      type: TYPE_RATIONAL,
      count: 3,
      payload: dms(lat[0], lat[1], lat[2], le),
    });
    gpsEntries.push(asciiEntry(0x0003, lngRef));
    gpsEntries.push({
      tag: 0x0004,
      type: TYPE_RATIONAL,
      count: 3,
      payload: dms(lng[0], lng[1], lng[2], le),
    });
  }

  const pointers: Entry[] = [];
  const exifOffset = 8 + ifdSize(Number(exifEntries.length > 0) + Number(gpsEntries.length > 0));
  const gpsOffset = exifOffset + (exifEntries.length > 0 ? ifdSize(exifEntries.length) : 0);
  const heapBase = gpsOffset + (gpsEntries.length > 0 ? ifdSize(gpsEntries.length) : 0);

  if (exifEntries.length > 0) {
    pointers.push({ tag: 0x8769, type: TYPE_LONG, count: 1, payload: u32(exifOffset, le) });
  }
  if (gpsEntries.length > 0) {
    pointers.push({ tag: 0x8825, type: TYPE_LONG, count: 1, payload: u32(gpsOffset, le) });
  }

  const heap: number[] = [];
  const exifIfd = exifEntries.length > 0 ? ifdBytes(exifEntries, le, heap, heapBase) : [];
  const gpsIfd = gpsEntries.length > 0 ? ifdBytes(gpsEntries, le, heap, heapBase) : [];
  const ifd0 = ifdBytes(pointers, le, heap, heapBase);

  return [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(options.badMagic ? 0x00ff : 0x002a, le),
    ...u32(8, le),
    ...ifd0,
    ...exifIfd,
    ...gpsIfd,
    ...heap,
  ];
}

/** A JPEG with a JFIF segment ahead of the EXIF one, which is what a camera actually writes. */
function buildJpeg(options: BuildOptions = {}): Blob {
  const tiff = buildTiff(options);
  const truncated = options.truncateTo === undefined ? tiff : tiff.slice(0, options.truncateTo);
  const app1Length = 2 + 6 + truncated.length;

  const bytes = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii('JFIF').slice(0, 5),
    1,
    2,
    0,
    0,
    1,
    0,
    1,
    0,
    0, // APP0
    0xff,
    0xe1,
    (app1Length >> 8) & 0xff,
    app1Length & 0xff, // APP1, length always big-endian
    ...ascii('Exif').slice(0, 5),
    0,
    ...truncated,
    0xff,
    0xd9, // EOI
  ];
  return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

/** Vesper Peak, to two decimal places of a second. */
const VESPER: Gps = {
  lat: [47, 46, 58.08],
  latRef: 'N',
  lng: [121, 29, 35.16],
  lngRef: 'W',
};

describe('readExif', () => {
  it('reads the capture time and the coordinate a phone writes', async () => {
    const facts = await readExif(
      buildJpeg({ date: '2024:09:14 07:32:10', zone: '+02:00', gps: VESPER }),
    );

    expect(facts.capturedAt?.toISOString()).toBe('2024-09-14T05:32:10.000Z');
    expect(facts.lat).toBeCloseTo(47.7828, 4);
    expect(facts.lng).toBeCloseTo(-121.4931, 4);
  });

  it('reads a big-endian file identically', async () => {
    // Canon and Nikon write MM; Apple writes II. Both are legal and both turn up.
    const facts = await readExif(
      buildJpeg({ littleEndian: false, date: '2024:09:14 07:32:10', zone: '+02:00', gps: VESPER }),
    );

    expect(facts.capturedAt?.toISOString()).toBe('2024-09-14T05:32:10.000Z');
    expect(facts.lat).toBeCloseTo(47.7828, 4);
    expect(facts.lng).toBeCloseTo(-121.4931, 4);
  });

  it('applies the hemisphere from the reference tags', async () => {
    // The magnitudes are identical; only the two one-character tags say which side of the
    // equator and the meridian. Those tags are stored inline, so this is also the assertion
    // that the four-byte shortcut is honoured.
    const facts = await readExif(
      buildJpeg({
        gps: { lat: [33, 51, 30], latRef: 'S', lng: [151, 12, 36], lngRef: 'E' },
      }),
    );

    expect(facts.lat).toBeCloseTo(-33.8583, 4);
    expect(facts.lng).toBeCloseTo(151.21, 4);
  });

  it('treats a missing zone as UTC rather than as local time', async () => {
    // A wrong guess here shifts every timestamp by the reader's own offset, which is how a
    // photograph taken at noon ends up captioned with the previous evening.
    const facts = await readExif(buildJpeg({ date: '2024:09:14 07:32:10' }));
    expect(facts.capturedAt?.toISOString()).toBe('2024-09-14T07:32:10.000Z');
  });

  it('returns nothing for a file with no EXIF at all', async () => {
    const bare = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
    expect(await readExif(bare)).toEqual({ capturedAt: null, lat: null, lng: null });
  });

  it('returns nothing for something that is not a JPEG', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
    expect(await readExif(png)).toEqual({ capturedAt: null, lat: null, lng: null });
  });

  it('returns nothing for an empty file', async () => {
    expect(await readExif(new Blob([]))).toEqual({ capturedAt: null, lat: null, lng: null });
  });

  it('survives a corrupt TIFF header', async () => {
    const facts = await readExif(buildJpeg({ badMagic: true, date: '2024:09:14 07:32:10' }));
    expect(facts).toEqual({ capturedAt: null, lat: null, lng: null });
  });

  it('survives a file truncated mid-IFD', async () => {
    // Half an upload, a bad SD card, a browser that handed us a partial blob. None of these
    // may throw: this runs before anything else in the upload path, and a throw here would
    // stop a perfectly good photograph from being sent.
    for (const truncateTo of [4, 10, 20, 40, 60]) {
      const facts = await readExif(
        buildJpeg({ date: '2024:09:14 07:32:10', gps: VESPER, truncateTo }),
      );
      expect(facts.lat === null || Number.isFinite(facts.lat)).toBe(true);
    }
  });

  it('rejects Null Island', async () => {
    // 0,0 is what a camera writes when the GPS never got a fix. It is in the Gulf of Guinea,
    // and a photograph pinned there is worse than one with no pin at all.
    const facts = await readExif(
      buildJpeg({ gps: { lat: [0, 0, 0], latRef: 'N', lng: [0, 0, 0], lngRef: 'E' } }),
    );
    expect(facts.lat).toBeNull();
    expect(facts.lng).toBeNull();
  });

  it('rejects a date the camera clearly invented', async () => {
    // An uninitialised clock reads 1970, and a dead battery reads 1980. Neither is a date
    // anybody photographed anything on.
    for (const date of ['1970:01:01 00:00:00', '1980:01:01 12:00:00', '2099:01:01 12:00:00']) {
      expect((await readExif(buildJpeg({ date }))).capturedAt).toBeNull();
    }
  });

  it('rejects a date it cannot parse', async () => {
    for (const date of ['not a date', '2024-09-14', '0000:00:00 00:00:00']) {
      expect((await readExif(buildJpeg({ date }))).capturedAt).toBeNull();
    }
  });

  it('reads a coordinate with no timestamp, and a timestamp with no coordinate', async () => {
    const located = await readExif(buildJpeg({ gps: VESPER }));
    expect(located.capturedAt).toBeNull();
    expect(located.lat).toBeCloseTo(47.7828, 4);

    const timed = await readExif(buildJpeg({ date: '2024:09:14 07:32:10' }));
    expect(timed.lat).toBeNull();
    expect(timed.capturedAt).not.toBeNull();
  });
});
