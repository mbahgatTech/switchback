import type { ActivityType, TrackFix } from '@switchback/core';
import { computeGainLoss } from './profile';
import { cleanFixes, fixDistancesM, summariseTrack } from './track';

/**
 * FIT encoder, written by hand against the published FIT Protocol (the Garmin SDK is a 2 MB
 * generated dependency for nine messages). GPX is what everything reads; FIT is what a Garmin
 * *loads*, arriving with the climb profile and virtual partner a GPX course cannot carry.
 *
 * File layout: a 14-byte header, then records, then a 2-byte CRC. A definition message names the
 * fields of a *local type* (0–15), and every data message on that type is those fields in that
 * order, with no keys on the wire — so a width wrong by one byte silently garbles every field
 * after it and the file still parses. Hence the tests decode bytes back rather than snapshot them.
 *
 * Absent values are written as the base type's invalid sentinel (0xFF for uint8, and so on),
 * never skipped: skipping shortens the message and desynchronises the reader from the definition.
 */

/** FIT counts seconds from 1989-12-31T00:00:00Z, not from the Unix epoch. */
export const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

const HEADER_SIZE = 14;

/** Protocol 2.0, encoded as a nibble pair. */
const PROTOCOL_VERSION = 0x20;

/** Profile 21.51, encoded as major × 100 + minor. Readers use it to pick field tables. */
const PROFILE_VERSION = 2151;

/**
 * Manufacturer 255 is "development", the id the spec reserves for anyone without one. Claiming
 * a real manufacturer id would put our files in someone else's device statistics.
 */
const MANUFACTURER_DEVELOPMENT = 255;
const PRODUCT_ID = 1;

/** `SWBC`, as a uint32. It identifies the writer, so every file we emit shares it. */
const SERIAL_NUMBER = 0x53574243;

/** Global message numbers, from the FIT profile. */
const MESG = {
  fileId: 0,
  session: 18,
  lap: 19,
  record: 20,
  event: 21,
  course: 31,
  coursePoint: 32,
  activity: 34,
} as const;

/** `file_id.type`. The first byte of meaning in the file — readers branch on it. */
const FILE_TYPE = { activity: 4, course: 6 } as const;

/**
 * FIT's `sport` enum. Activity types with no FIT equivalent map to the nearest one a device
 * understands rather than `generic` — a scramble as `mountaineering` gets sensible ascent
 * handling, as `generic` gets none. `sub_sport` carries trail-vs-road, which devices treat
 * differently for everything downstream.
 */
const FIT_SPORT: Readonly<Record<ActivityType, number>> = {
  hiking: 17,
  trail_running: 1,
  backpacking: 17,
  mountain_biking: 2,
  road_biking: 2,
  horseback_riding: 27,
  snowshoeing: 35,
  skiing: 12,
  via_ferrata: 16,
  scrambling: 16,
};

const FIT_SUB_SPORT: Readonly<Partial<Record<ActivityType, number>>> = {
  trail_running: 3,
  mountain_biking: 8,
  road_biking: 7,
};

/** `course.capabilities`: processed, valid, time, distance, position, navigation. */
const COURSE_CAPABILITIES = 0x001 | 0x002 | 0x004 | 0x008 | 0x010 | 0x200;

/** `course_point.type` — 0 is a plain waypoint, 1 is a summit. */
const COURSE_POINT_TYPE = { generic: 0, summit: 1 } as const;

/** Bytes reserved for a course point's name. Fixed so all three share one definition. */
const COURSE_POINT_NAME_BYTES = 16;

/**
 * Fallback course pace, 1.1 m/s (~4 km/h). Only reached when a route has no stored estimate;
 * every route saved through the planner carries a Tobler estimate over its real profile.
 */
const COURSE_DEFAULT_SPEED_MPS = 1.1;

interface BaseType {
  /** The base-type byte written into a definition: bit 7 is endian ability. */
  readonly id: number;
  readonly size: number;
  /** The value that means "this field was not measured". */
  readonly invalid: number;
}

const BASE = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff },
  sint32: { id: 0x85, size: 4, invalid: 0x7fffffff },
  uint32z: { id: 0x8c, size: 4, invalid: 0 },
  string: { id: 0x07, size: 1, invalid: 0 },
} as const satisfies Record<string, BaseType>;

type BaseTypeName = keyof typeof BASE;

interface FitField {
  readonly num: number;
  readonly base: BaseTypeName;
  /** Bytes on the wire. Only strings need it; everything else is its base type's width. */
  readonly size?: number;
}

interface FitEntry {
  readonly field: FitField;
  readonly value: number | string | null;
}

/**
 * FIT's CRC-16, table-driven a nibble at a time. Same polynomial as Modbus, but indexed by four
 * bits rather than eight — the shape the spec presents, so it checks against the document.
 */
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
] as const;

export function fitCrc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;

    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
  }
  return crc & 0xffff;
}

/**
 * A growable little-endian byte sink. Definition messages declare little-endian in their
 * architecture byte, so output is identical on a big-endian host.
 */
class FitWriter {
  private buffer = new Uint8Array(4096);
  private length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buffer[this.length] = value & 0xff;
    this.length += 1;
  }

  u16(value: number): void {
    const raw = value >>> 0;
    this.u8(raw);
    this.u8(raw >>> 8);
  }

  u32(value: number): void {
    const raw = value >>> 0;
    this.u8(raw);
    this.u8(raw >>> 8);
    this.u8(raw >>> 16);
    this.u8(raw >>> 24);
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/**
 * UTF-8 bytes for `text`, truncated to `maxBytes` at a character boundary. Hand-rolled because
 * this package is imported by the iOS app and Hermes does not reliably provide `TextEncoder`;
 * cutting mid-sequence yields bytes that are not UTF-8 and a watch shows a replacement character.
 */
function utf8Bytes(text: string, maxBytes: number): number[] {
  const out: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const encoded: number[] =
      cp < 0x80
        ? [cp]
        : cp < 0x800
          ? [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)]
          : cp < 0x10000
            ? [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)]
            : [
                0xf0 | (cp >> 18),
                0x80 | ((cp >> 12) & 0x3f),
                0x80 | ((cp >> 6) & 0x3f),
                0x80 | (cp & 0x3f),
              ];
    if (out.length + encoded.length > maxBytes) break;
    out.push(...encoded);
  }
  return out;
}

function fieldWidth(field: FitField): number {
  return field.size ?? BASE[field.base].size;
}

/**
 * Announce the shape of every data message that follows on this local type. A local type is a
 * slot, 0–15, not an identity: redefining one mid-file legally changes what its later messages
 * mean. This encoder never reuses a slot, so each definition is emitted once at first use.
 */
function emitDefinition(
  writer: FitWriter,
  local: number,
  global: number,
  fields: readonly FitField[],
): void {
  writer.u8(0x40 | (local & 0x0f)); // definition-message header
  writer.u8(0); // reserved
  writer.u8(0); // architecture: little-endian
  writer.u16(global);
  writer.u8(fields.length);
  for (const field of fields) {
    writer.u8(field.num);
    writer.u8(fieldWidth(field));
    writer.u8(BASE[field.base].id);
  }
}

function emitValue(writer: FitWriter, field: FitField, value: number | string | null): void {
  const width = fieldWidth(field);
  if (field.base === 'string') {
    const bytes = utf8Bytes(typeof value === 'string' ? value : '', width - 1);
    for (let i = 0; i < width; i++) writer.u8(i < bytes.length ? bytes[i]! : 0);
    return;
  }

  const base = BASE[field.base];
  const raw =
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : base.invalid;
  if (width === 1) writer.u8(raw);
  else if (width === 2) writer.u16(raw);
  else writer.u32(raw);
}

function emitData(
  writer: FitWriter,
  local: number,
  fields: readonly FitField[],
  values: ReadonlyArray<number | string | null>,
): void {
  writer.u8(local & 0x0f); // data-message header, bit 6 clear
  for (let i = 0; i < fields.length; i++) emitValue(writer, fields[i]!, values[i] ?? null);
}

/** A message that appears once: define its local type and immediately write the one row. */
function emitOne(
  writer: FitWriter,
  local: number,
  global: number,
  entries: readonly FitEntry[],
): void {
  const fields = entries.map((entry) => entry.field);
  emitDefinition(writer, local, global, fields);
  emitData(
    writer,
    local,
    fields,
    entries.map((entry) => entry.value),
  );
}

/** Wrap the record stream in its header and both CRCs. */
function sealFile(records: Uint8Array): Uint8Array {
  const total = HEADER_SIZE + records.length + 2;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = HEADER_SIZE;
  out[1] = PROTOCOL_VERSION;
  view.setUint16(2, PROFILE_VERSION, true);
  view.setUint32(4, records.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  // The header carries its own CRC over its first twelve bytes; the file CRC covers the header
  // *including* that one, plus every record.
  view.setUint16(12, fitCrc16(out.subarray(0, 12)), true);

  out.set(records, HEADER_SIZE);
  view.setUint16(total - 2, fitCrc16(out.subarray(0, total - 2)), true);
  return out;
}

/** Degrees to semicircles: FIT stores position as a signed 32-bit fraction of a turn. */
const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

function semicircles(deg: number): number | null {
  if (!Number.isFinite(deg)) return null;
  return Math.round(deg * SEMICIRCLES_PER_DEGREE);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** `altitude` is uint16 with scale 5 and offset 500, so it runs from −500 m to 12,553 m. */
function altitudeRaw(eleM: number | null | undefined): number | null {
  if (eleM == null || !Number.isFinite(eleM)) return null;
  return clamp(Math.round((eleM + 500) * 5), 0, 0xfffe);
}

function fitTimestamp(ms: number): number {
  return Math.max(0, Math.round((ms - FIT_EPOCH_MS) / 1000));
}

/** Seconds to the uint32 milliseconds every duration field in FIT is scaled to. */
function durationRaw(seconds: number | null | undefined): number | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return Math.max(0, Math.round(seconds * 1000));
}

function speedRaw(mps: number | null | undefined): number | null {
  if (mps == null || !Number.isFinite(mps) || mps < 0) return null;
  return clamp(Math.round(mps * 1000), 0, 0xfffe);
}

function distanceRaw(metres: number): number {
  return Math.max(0, Math.round(metres * 100));
}

const FILE_ID = {
  type: { num: 0, base: 'enum' },
  manufacturer: { num: 1, base: 'uint16' },
  product: { num: 2, base: 'uint16' },
  serialNumber: { num: 3, base: 'uint32z' },
  timeCreated: { num: 4, base: 'uint32' },
} as const satisfies Record<string, FitField>;

const RECORD = {
  positionLat: { num: 0, base: 'sint32' },
  positionLong: { num: 1, base: 'sint32' },
  altitude: { num: 2, base: 'uint16' },
  heartRate: { num: 3, base: 'uint8' },
  distance: { num: 5, base: 'uint32' },
  speed: { num: 6, base: 'uint16' },
  timestamp: { num: 253, base: 'uint32' },
} as const satisfies Record<string, FitField>;

const EVENT = {
  event: { num: 0, base: 'enum' },
  eventType: { num: 1, base: 'enum' },
  data: { num: 3, base: 'uint32' },
  timestamp: { num: 253, base: 'uint32' },
} as const satisfies Record<string, FitField>;

const LAP = {
  event: { num: 0, base: 'enum' },
  eventType: { num: 1, base: 'enum' },
  startTime: { num: 2, base: 'uint32' },
  startPositionLat: { num: 3, base: 'sint32' },
  startPositionLong: { num: 4, base: 'sint32' },
  endPositionLat: { num: 5, base: 'sint32' },
  endPositionLong: { num: 6, base: 'sint32' },
  totalElapsedTime: { num: 7, base: 'uint32' },
  totalTimerTime: { num: 8, base: 'uint32' },
  totalDistance: { num: 9, base: 'uint32' },
  avgSpeed: { num: 13, base: 'uint16' },
  maxSpeed: { num: 14, base: 'uint16' },
  avgHeartRate: { num: 15, base: 'uint8' },
  maxHeartRate: { num: 16, base: 'uint8' },
  totalAscent: { num: 21, base: 'uint16' },
  totalDescent: { num: 22, base: 'uint16' },
  lapTrigger: { num: 24, base: 'enum' },
  sport: { num: 25, base: 'enum' },
  timestamp: { num: 253, base: 'uint32' },
  messageIndex: { num: 254, base: 'uint16' },
} as const satisfies Record<string, FitField>;

const SESSION = {
  event: { num: 0, base: 'enum' },
  eventType: { num: 1, base: 'enum' },
  startTime: { num: 2, base: 'uint32' },
  startPositionLat: { num: 3, base: 'sint32' },
  startPositionLong: { num: 4, base: 'sint32' },
  sport: { num: 5, base: 'enum' },
  subSport: { num: 6, base: 'enum' },
  totalElapsedTime: { num: 7, base: 'uint32' },
  totalTimerTime: { num: 8, base: 'uint32' },
  totalDistance: { num: 9, base: 'uint32' },
  avgSpeed: { num: 14, base: 'uint16' },
  maxSpeed: { num: 15, base: 'uint16' },
  avgHeartRate: { num: 16, base: 'uint8' },
  maxHeartRate: { num: 17, base: 'uint8' },
  totalAscent: { num: 22, base: 'uint16' },
  totalDescent: { num: 23, base: 'uint16' },
  firstLapIndex: { num: 25, base: 'uint16' },
  numLaps: { num: 26, base: 'uint16' },
  trigger: { num: 28, base: 'enum' },
  timestamp: { num: 253, base: 'uint32' },
  messageIndex: { num: 254, base: 'uint16' },
} as const satisfies Record<string, FitField>;

const ACTIVITY = {
  totalTimerTime: { num: 0, base: 'uint32' },
  numSessions: { num: 1, base: 'uint16' },
  type: { num: 2, base: 'enum' },
  event: { num: 3, base: 'enum' },
  eventType: { num: 4, base: 'enum' },
  localTimestamp: { num: 5, base: 'uint32' },
  timestamp: { num: 253, base: 'uint32' },
} as const satisfies Record<string, FitField>;

const COURSE_POINT = {
  timestamp: { num: 1, base: 'uint32' },
  positionLat: { num: 2, base: 'sint32' },
  positionLong: { num: 3, base: 'sint32' },
  distance: { num: 4, base: 'uint32' },
  type: { num: 5, base: 'enum' },
  name: { num: 6, base: 'string', size: COURSE_POINT_NAME_BYTES },
  messageIndex: { num: 254, base: 'uint16' },
} as const satisfies Record<string, FitField>;

/** `event` = timer, `event_type` = start / stop_all. */
const TIMER_EVENT = 0;
const EVENT_TYPE_START = 0;
const EVENT_TYPE_STOP = 1;
const EVENT_TYPE_STOP_ALL = 4;
const LAP_EVENT = 9;
const SESSION_EVENT = 8;
const ACTIVITY_EVENT = 26;
/** `lap_trigger` = session_end; `session.trigger` = activity_end; `activity.type` = manual. */
const LAP_TRIGGER_SESSION_END = 7;
const SESSION_TRIGGER_ACTIVITY_END = 0;
const ACTIVITY_TYPE_MANUAL = 0;

function fileIdEntries(type: number, createdMs: number): FitEntry[] {
  return [
    { field: FILE_ID.type, value: type },
    { field: FILE_ID.manufacturer, value: MANUFACTURER_DEVELOPMENT },
    { field: FILE_ID.product, value: PRODUCT_ID },
    { field: FILE_ID.serialNumber, value: SERIAL_NUMBER },
    { field: FILE_ID.timeCreated, value: fitTimestamp(createdMs) },
  ];
}

export interface FitActivityOptions {
  name: string;
  startedAt: Date;
  activityType: ActivityType;
  /**
   * Seconds east of UTC where the hike happened, written as `activity.local_timestamp` — a
   * reader recovers the offset by subtracting `timestamp`. Omitted when unknown, never guessed.
   */
  utcOffsetS?: number;
}

/**
 * A recorded hike as a FIT activity file.
 *
 * Message order is load-bearing: identity, timer start, records, timer stop, then summaries
 * narrowest to widest — lap, session, activity. Streaming readers depend on it, and a session
 * arriving before the records it summarises is the classic zero-distance import.
 *
 * Totals come from `summariseTrack`, not from re-adding the records, so the watch and this
 * product show the same number including the jitter floor and moving-time threshold.
 */
export function toFitActivity(fixes: readonly TrackFix[], options: FitActivityOptions): Uint8Array {
  const clean = cleanFixes(fixes);
  const stats = summariseTrack(clean);
  const distances = fixDistancesM(clean);
  const startMs = options.startedAt.getTime();
  const at = (fix: TrackFix): number => fitTimestamp(startMs + fix.t * 1000);

  const first = clean[0] ?? null;
  const last = clean[clean.length - 1] ?? null;
  const heartRates = clean
    .map((fix) => fix.heartRate)
    .filter((hr): hr is number => hr != null && Number.isFinite(hr));

  const writer = new FitWriter();
  emitOne(writer, 0, MESG.fileId, fileIdEntries(FILE_TYPE.activity, startMs));

  // Defined up front so the matching stop can be written after the records without a second
  // definition — one local type, two rows, the records in between.
  const eventFields = [EVENT.event, EVENT.eventType, EVENT.data, EVENT.timestamp];
  emitDefinition(writer, 1, MESG.event, eventFields);
  emitData(writer, 1, eventFields, [
    TIMER_EVENT,
    EVENT_TYPE_START,
    0,
    fitTimestamp(startMs + (first?.t ?? 0) * 1000),
  ]);

  const recordFields: FitField[] = [
    RECORD.positionLat,
    RECORD.positionLong,
    RECORD.altitude,
    ...(heartRates.length > 0 ? [RECORD.heartRate] : []),
    RECORD.distance,
    RECORD.speed,
    RECORD.timestamp,
  ];
  emitDefinition(writer, 2, MESG.record, recordFields);
  for (let i = 0; i < clean.length; i++) {
    const fix = clean[i]!;
    const previous = i > 0 ? clean[i - 1]! : null;
    const dt = previous ? fix.t - previous.t : 0;
    const step = previous ? distances[i]! - distances[i - 1]! : 0;
    emitData(writer, 2, recordFields, [
      semicircles(fix.lat),
      semicircles(fix.lng),
      altitudeRaw(fix.eleM),
      ...(heartRates.length > 0 ? [fix.heartRate ?? null] : []),
      distanceRaw(distances[i]!),
      dt > 0 ? speedRaw(step / dt) : 0,
      at(fix),
    ]);
  }

  emitData(writer, 1, eventFields, [
    TIMER_EVENT,
    EVENT_TYPE_STOP_ALL,
    0,
    fitTimestamp(startMs + (last?.t ?? 0) * 1000),
  ]);

  const endMs = startMs + (last?.t ?? 0) * 1000;
  const withHeartRate = heartRates.length > 0;
  const avgHeartRate = withHeartRate
    ? Math.round(heartRates.reduce((sum, hr) => sum + hr, 0) / heartRates.length)
    : null;
  const maxHeartRate = withHeartRate ? Math.max(...heartRates) : null;

  emitOne(writer, 3, MESG.lap, [
    { field: LAP.event, value: LAP_EVENT },
    { field: LAP.eventType, value: EVENT_TYPE_STOP },
    { field: LAP.startTime, value: fitTimestamp(startMs) },
    { field: LAP.startPositionLat, value: first ? semicircles(first.lat) : null },
    { field: LAP.startPositionLong, value: first ? semicircles(first.lng) : null },
    { field: LAP.endPositionLat, value: last ? semicircles(last.lat) : null },
    { field: LAP.endPositionLong, value: last ? semicircles(last.lng) : null },
    { field: LAP.totalElapsedTime, value: durationRaw(stats.elapsedTimeS) },
    { field: LAP.totalTimerTime, value: durationRaw(stats.movingTimeS) },
    { field: LAP.totalDistance, value: distanceRaw(stats.distanceM) },
    { field: LAP.avgSpeed, value: speedRaw(stats.avgSpeedMps) },
    { field: LAP.maxSpeed, value: speedRaw(stats.maxSpeedMps) },
    { field: LAP.avgHeartRate, value: avgHeartRate },
    { field: LAP.maxHeartRate, value: maxHeartRate },
    { field: LAP.totalAscent, value: stats.gainM },
    { field: LAP.totalDescent, value: stats.lossM },
    { field: LAP.lapTrigger, value: LAP_TRIGGER_SESSION_END },
    { field: LAP.sport, value: FIT_SPORT[options.activityType] },
    { field: LAP.timestamp, value: fitTimestamp(endMs) },
    { field: LAP.messageIndex, value: 0 },
  ]);

  emitOne(writer, 4, MESG.session, [
    { field: SESSION.event, value: SESSION_EVENT },
    { field: SESSION.eventType, value: EVENT_TYPE_STOP },
    { field: SESSION.startTime, value: fitTimestamp(startMs) },
    { field: SESSION.startPositionLat, value: first ? semicircles(first.lat) : null },
    { field: SESSION.startPositionLong, value: first ? semicircles(first.lng) : null },
    { field: SESSION.sport, value: FIT_SPORT[options.activityType] },
    { field: SESSION.subSport, value: FIT_SUB_SPORT[options.activityType] ?? 0 },
    { field: SESSION.totalElapsedTime, value: durationRaw(stats.elapsedTimeS) },
    { field: SESSION.totalTimerTime, value: durationRaw(stats.movingTimeS) },
    { field: SESSION.totalDistance, value: distanceRaw(stats.distanceM) },
    { field: SESSION.avgSpeed, value: speedRaw(stats.avgSpeedMps) },
    { field: SESSION.maxSpeed, value: speedRaw(stats.maxSpeedMps) },
    { field: SESSION.avgHeartRate, value: avgHeartRate },
    { field: SESSION.maxHeartRate, value: maxHeartRate },
    { field: SESSION.totalAscent, value: stats.gainM },
    { field: SESSION.totalDescent, value: stats.lossM },
    { field: SESSION.firstLapIndex, value: 0 },
    { field: SESSION.numLaps, value: 1 },
    { field: SESSION.trigger, value: SESSION_TRIGGER_ACTIVITY_END },
    { field: SESSION.timestamp, value: fitTimestamp(endMs) },
    { field: SESSION.messageIndex, value: 0 },
  ]);

  emitOne(writer, 5, MESG.activity, [
    { field: ACTIVITY.totalTimerTime, value: durationRaw(stats.movingTimeS) },
    { field: ACTIVITY.numSessions, value: 1 },
    { field: ACTIVITY.type, value: ACTIVITY_TYPE_MANUAL },
    { field: ACTIVITY.event, value: ACTIVITY_EVENT },
    { field: ACTIVITY.eventType, value: EVENT_TYPE_STOP },
    // Dropped from the definition rather than written as the invalid sentinel: 0xFFFFFFFF is
    // also 136 years of seconds, and a reader that forgets to check invalid on this one field
    // shows the hike happening in 2126. Absent is a state every reader handles.
    ...(options.utcOffsetS != null
      ? [
          {
            field: ACTIVITY.localTimestamp,
            value: fitTimestamp(endMs) + Math.round(options.utcOffsetS),
          },
        ]
      : []),
    { field: ACTIVITY.timestamp, value: fitTimestamp(endMs) },
  ]);

  return sealFile(writer.toBytes());
}

export interface RoutePoint {
  lng: number;
  lat: number;
  eleM: number;
}

export interface FitCourseOptions {
  name: string;
  activityType: ActivityType;
  /** Stamped into the file and used as the base for the virtual partner's clock. */
  createdAt: Date;
  /** Tobler's estimate over the real profile. The virtual partner is paced by it. */
  estimatedTimeS?: number | null;
}

/**
 * A planned route as a FIT course file. A course is navigated, not replayed, which changes three
 * things: record timestamps are fiction that a Garmin turns into the virtual partner, spread over
 * the route from the planner's Tobler estimate so "ahead of schedule" accounts for the climb; the
 * lap message is required, since a course without one refuses to start on several Garmin models;
 * and three course points ship — start, high point, finish — to mark the summit on the climb graph.
 */
export function toFitCourse(points: readonly RoutePoint[], options: FitCourseOptions): Uint8Array {
  const createdMs = options.createdAt.getTime();
  const startTime = fitTimestamp(createdMs);

  // Cumulative distance plus the running elevation series the lap's ascent comes from. One
  // pass, because the two must describe the same line.
  const distances: number[] = [];
  let running = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const previous = i > 0 ? points[i - 1]! : null;
    if (previous) running += haversine(previous, point);
    distances.push(running);
  }
  const totalM = running;
  const { gainM, lossM } = computeGainLoss(points.map((point) => point.eleM));

  const durationS =
    options.estimatedTimeS != null && options.estimatedTimeS > 0
      ? options.estimatedTimeS
      : totalM / COURSE_DEFAULT_SPEED_MPS;
  const secondsAt = (index: number): number =>
    totalM > 0 ? (distances[index]! / totalM) * durationS : 0;

  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  const highIndex = points.reduce(
    (best, point, index) => (point.eleM > (points[best]?.eleM ?? -Infinity) ? index : best),
    0,
  );

  const writer = new FitWriter();
  emitOne(writer, 0, MESG.fileId, fileIdEntries(FILE_TYPE.course, createdMs));

  const nameBytes = utf8Bytes(options.name, 62).length;
  emitOne(writer, 1, MESG.course, [
    { field: { num: 4, base: 'enum' }, value: FIT_SPORT[options.activityType] },
    { field: { num: 5, base: 'string', size: nameBytes + 1 }, value: options.name },
    { field: { num: 6, base: 'uint32z' }, value: COURSE_CAPABILITIES },
    { field: { num: 7, base: 'enum' }, value: FIT_SUB_SPORT[options.activityType] ?? 0 },
  ]);

  emitOne(writer, 2, MESG.lap, [
    { field: LAP.startTime, value: startTime },
    { field: LAP.startPositionLat, value: first ? semicircles(first.lat) : null },
    { field: LAP.startPositionLong, value: first ? semicircles(first.lng) : null },
    { field: LAP.endPositionLat, value: last ? semicircles(last.lat) : null },
    { field: LAP.endPositionLong, value: last ? semicircles(last.lng) : null },
    { field: LAP.totalElapsedTime, value: durationRaw(durationS) },
    { field: LAP.totalTimerTime, value: durationRaw(durationS) },
    { field: LAP.totalDistance, value: distanceRaw(totalM) },
    { field: LAP.avgSpeed, value: durationS > 0 ? speedRaw(totalM / durationS) : null },
    { field: LAP.totalAscent, value: Math.round(gainM) },
    { field: LAP.totalDescent, value: Math.round(lossM) },
    { field: LAP.timestamp, value: startTime + Math.round(durationS) },
    { field: LAP.messageIndex, value: 0 },
  ]);

  const recordFields = [
    RECORD.positionLat,
    RECORD.positionLong,
    RECORD.altitude,
    RECORD.distance,
    RECORD.timestamp,
  ];
  emitDefinition(writer, 3, MESG.record, recordFields);
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    emitData(writer, 3, recordFields, [
      semicircles(point.lat),
      semicircles(point.lng),
      altitudeRaw(point.eleM),
      distanceRaw(distances[i]!),
      startTime + Math.round(secondsAt(i)),
    ]);
  }

  // Start, summit, finish — only if distinct, or a course whose start is its high point would
  // carry two markers on one pixel.
  const marks: Array<{ index: number; type: number; name: string }> = [];
  if (first) marks.push({ index: 0, type: COURSE_POINT_TYPE.generic, name: 'Start' });
  if (highIndex > 0 && highIndex < points.length - 1) {
    marks.push({ index: highIndex, type: COURSE_POINT_TYPE.summit, name: 'High point' });
  }
  if (last && points.length > 1) {
    marks.push({ index: points.length - 1, type: COURSE_POINT_TYPE.generic, name: 'Finish' });
  }

  if (marks.length > 0) {
    const pointFields = [
      COURSE_POINT.timestamp,
      COURSE_POINT.positionLat,
      COURSE_POINT.positionLong,
      COURSE_POINT.distance,
      COURSE_POINT.type,
      COURSE_POINT.name,
      COURSE_POINT.messageIndex,
    ];
    emitDefinition(writer, 4, MESG.coursePoint, pointFields);
    marks.forEach((mark, order) => {
      const point = points[mark.index]!;
      emitData(writer, 4, pointFields, [
        startTime + Math.round(secondsAt(mark.index)),
        semicircles(point.lat),
        semicircles(point.lng),
        distanceRaw(distances[mark.index]!),
        mark.type,
        mark.name,
        order,
      ]);
    });
  }

  return sealFile(writer.toBytes());
}

/**
 * Great-circle metres between two route points. Local rather than imported from `./distance`
 * only because that module speaks `LngLat` tuples and this one speaks objects.
 */
function haversine(a: RoutePoint, b: RoutePoint): number {
  const R = 6_371_008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 for the wire, hand-rolled for the same reason as `utf8Bytes`: on iOS `Buffer` does not
 * exist and `btoa` is not guaranteed — and there base64 is the exact form `expo-file-system` wants.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BASE64_ALPHABET[a >> 2]!;
    out += BASE64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : BASE64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : BASE64_ALPHABET[c & 0x3f]!;
  }
  return out;
}
