/**
 * Just enough EXIF to answer two questions: when was this taken, and where.
 *
 * Both matter here. The date is what lets a gallery say "September 2024" rather than the
 * moment somebody happened to upload it, and the coordinates are what pin a photograph to a
 * point on the elevation profile — the difference between a strip of pictures beside a trail
 * and a picture of *that* switchback, at 4.2 km, where the trees stop.
 *
 * It has to run before the canvas touches the file. Re-encoding through a canvas strips
 * every EXIF tag, which is the right default for privacy and means the metadata is only
 * readable in the seconds between choosing the file and processing it.
 *
 * **Scope is deliberate.** This is not an EXIF library — it hikes IFD0, the Exif sub-IFD and
 * the GPS sub-IFD looking for four tags, and gives up quietly on anything it does not
 * understand. A malformed or absent block is the ordinary case, not an error: PNGs have no
 * APP1 segment at all, and every screenshot and messaging app strips what it finds.
 *
 * **This file is the browser's half only.** What counts as a believable timestamp and a real
 * GPS fix lives in `@switchback/core` — iOS reads the same two facts out of a dictionary
 * Core Graphics parsed for it, and the two clients must agree about the answers even though
 * they cannot share the reading.
 */

import { exifCoordinate, parseExifDateTime } from '@switchback/core';

const APP1 = 0xffe1;
const EXIF_HEADER = 0x45786966; // "Exif"

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LNG_REF = 0x0003;
const TAG_GPS_LNG = 0x0004;

/** Bytes per component, indexed by EXIF type code. Zero for types we do not read. */
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 0, 1, 0, 4, 8] as const;

export interface ExifFacts {
  capturedAt: Date | null;
  lat: number | null;
  lng: number | null;
}

const NOTHING: ExifFacts = { capturedAt: null, lat: null, lng: null };

interface Entry {
  type: number;
  count: number;
  /** Absolute offset into the TIFF block, already resolved past the inline-value shortcut. */
  offset: number;
}

/** One IFD, read as a map from tag to where its value lives. */
function readIfd(view: DataView, tiff: number, ifd: number, le: boolean): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  if (ifd + 2 > view.byteLength) return entries;

  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > view.byteLength) break;

    const tag = view.getUint16(at, le);
    const type = view.getUint16(at + 2, le);
    const components = view.getUint32(at + 4, le);
    const size = (TYPE_SIZES[type] ?? 0) * components;
    if (size === 0) continue;

    // A value of four bytes or fewer is stored in the offset field itself rather than
    // pointed at. Missing this is the classic EXIF bug: every short and every one-character
    // ref tag ("N", "W") is inline, so a parser that always dereferences reads garbage from
    // wherever those four bytes happen to point.
    const offset = size <= 4 ? at + 8 : tiff + view.getUint32(at + 8, le);
    entries.set(tag, { type, count: components, offset });
  }
  return entries;
}

function readAscii(view: DataView, entry: Entry): string | null {
  if (entry.type !== 2) return null;
  let out = '';
  for (let i = 0; i < entry.count; i++) {
    const at = entry.offset + i;
    if (at >= view.byteLength) break;
    const code = view.getUint8(at);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim() || null;
}

function readRational(view: DataView, offset: number, le: boolean): number {
  if (offset + 8 > view.byteLength) return Number.NaN;
  const denominator = view.getUint32(offset + 4, le);
  return denominator === 0 ? Number.NaN : view.getUint32(offset, le) / denominator;
}

/** Degrees, minutes and seconds as three rationals — EXIF's only representation of an angle. */
function readCoordinate(view: DataView, entry: Entry | undefined, le: boolean): number | null {
  if (!entry || entry.type !== 5 || entry.count < 3) return null;
  const degrees = readRational(view, entry.offset, le);
  const minutes = readRational(view, entry.offset + 8, le);
  const seconds = readRational(view, entry.offset + 16, le);
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return degrees + minutes / 60 + seconds / 3600;
}

/**
 * Locate the TIFF block inside a JPEG's APP1 segment, or null if there is not one.
 */
function findTiffOffset(view: DataView): number | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG

  let at = 2;
  while (at + 4 <= view.byteLength) {
    const marker = view.getUint16(at);
    // Markers are 0xFFxx. Anything else means the scan has run off into entropy-coded data,
    // which is past every metadata segment there is.
    if ((marker & 0xff00) !== 0xff00) return null;
    const length = view.getUint16(at + 2);
    if (length < 2) return null;

    if (marker === APP1 && at + 10 <= view.byteLength && view.getUint32(at + 4) === EXIF_HEADER) {
      return at + 10; // past the marker, length, "Exif" and two NUL bytes
    }
    at += 2 + length;
  }
  return null;
}

/**
 * Read what we need, or return nulls.
 *
 * Never throws. This runs on a file a person just chose, at the moment they chose it, and a
 * corrupt metadata block is not a reason to refuse their photograph.
 */
export async function readExif(file: Blob): Promise<ExifFacts> {
  try {
    // 128 kB is far past where APP1 lives in every camera and phone JPEG. Reading the whole
    // file would mean holding a 12 MB buffer to look at its first few hundred bytes.
    const head = await file.slice(0, 128 * 1024).arrayBuffer();
    const view = new DataView(head);

    const tiff = findTiffOffset(view);
    if (tiff === null || tiff + 8 > view.byteLength) return NOTHING;

    const byteOrder = view.getUint16(tiff);
    if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return NOTHING;
    const le = byteOrder === 0x4949;
    if (view.getUint16(tiff + 2, le) !== 0x002a) return NOTHING;

    const ifd0 = readIfd(view, tiff, tiff + view.getUint32(tiff + 4, le), le);

    let capturedAt: Date | null = null;
    const exifPointer = ifd0.get(TAG_EXIF_IFD);
    if (exifPointer) {
      const exif = readIfd(view, tiff, tiff + view.getUint32(exifPointer.offset, le), le);
      const original = exif.get(TAG_DATE_TIME_ORIGINAL);
      const zone = exif.get(TAG_OFFSET_TIME_ORIGINAL);
      capturedAt = parseExifDateTime(
        original ? readAscii(view, original) : null,
        zone ? readAscii(view, zone) : null,
      );
    }

    let lat: number | null = null;
    let lng: number | null = null;
    const gpsPointer = ifd0.get(TAG_GPS_IFD);
    if (gpsPointer) {
      const gps = readIfd(view, tiff, tiff + view.getUint32(gpsPointer.offset, le), le);
      const latRef = gps.get(TAG_GPS_LAT_REF);
      const lngRef = gps.get(TAG_GPS_LNG_REF);
      const latitude = readCoordinate(view, gps.get(TAG_GPS_LAT), le);
      const longitude = readCoordinate(view, gps.get(TAG_GPS_LNG), le);

      if (latitude !== null && longitude !== null) {
        // The refs are read here and judged next door: `exifCoordinate` applies the sign, so
        // the browser and the phone cannot end up disagreeing about which way is south.
        const fix = exifCoordinate(
          latitude,
          latRef ? readAscii(view, latRef) : null,
          longitude,
          lngRef ? readAscii(view, lngRef) : null,
        );
        if (fix) {
          lat = fix.lat;
          lng = fix.lng;
        }
      }
    }

    return { capturedAt, lat, lng };
  } catch {
    return NOTHING;
  }
}
