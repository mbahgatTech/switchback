import { describe, expect, it } from 'vitest';
import type { TrackFix } from '@switchback/core';
import { FIT_EPOCH_MS, encodeBase64, fitCrc16, toFitActivity, toFitCourse } from '../src/fit';
import { summariseTrack } from '../src/track';

/**
 * These tests decode the bytes rather than snapshotting them: a field width disagreeing with its
 * definition produces a stable, reproducible, entirely wrong file. The decoder below is written
 * from the spec, not from the encoder, so agreeing on something wrong takes two mistakes.
 */

/** Width, invalidity and signedness by base-type index — the reader's whole type table. */
const BASE_INFO: Readonly<Record<number, { width: number; invalid: number; signed: boolean }>> = {
  0x00: { width: 1, invalid: 0xff, signed: false }, // enum
  0x01: { width: 1, invalid: 0x7f, signed: true }, // sint8
  0x02: { width: 1, invalid: 0xff, signed: false }, // uint8
  0x03: { width: 2, invalid: 0x7fff, signed: true }, // sint16
  0x04: { width: 2, invalid: 0xffff, signed: false }, // uint16
  0x05: { width: 4, invalid: 0x7fffffff, signed: true }, // sint32
  0x06: { width: 4, invalid: 0xffffffff, signed: false }, // uint32
  0x0c: { width: 4, invalid: 0, signed: false }, // uint32z
};

const STRING_BASE = 0x07;

interface FieldDef {
  num: number;
  size: number;
  base: number;
}

interface Message {
  global: number;
  fields: Record<number, number | string | null>;
}

interface DecodedFile {
  protocolVersion: number;
  profileVersion: number;
  messages: Message[];
}

function readValue(bytes: Uint8Array, offset: number, field: FieldDef): number | string | null {
  const typeIndex = field.base & 0x1f;
  if (typeIndex === STRING_BASE) {
    let end = offset;
    while (end < offset + field.size && bytes[end] !== 0) end += 1;
    if (end === offset) return null;
    return new TextDecoder().decode(bytes.subarray(offset, end));
  }

  const info = BASE_INFO[typeIndex];
  if (!info) throw new Error(`unknown base type 0x${typeIndex.toString(16)}`);
  if (field.size !== info.width) {
    throw new Error(
      `field ${field.num}: declared ${field.size} bytes for a ${info.width}-byte type`,
    );
  }

  let raw = 0;
  for (let i = info.width - 1; i >= 0; i--) raw = raw * 256 + bytes[offset + i]!;
  if (raw === info.invalid) return null;
  if (info.signed && raw >= 2 ** (info.width * 8 - 1)) raw -= 2 ** (info.width * 8);
  return raw;
}

function decodeFit(bytes: Uint8Array): DecodedFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const headerSize = bytes[0]!;
  expect(headerSize).toBe(14);
  expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
  expect(view.getUint16(12, true)).toBe(fitCrc16(bytes.subarray(0, 12)));

  const dataSize = view.getUint32(4, true);
  expect(bytes.length).toBe(headerSize + dataSize + 2);
  expect(view.getUint16(bytes.length - 2, true)).toBe(
    fitCrc16(bytes.subarray(0, bytes.length - 2)),
  );

  const definitions = new Map<number, { global: number; fields: FieldDef[] }>();
  const messages: Message[] = [];
  let pos = headerSize;
  const end = headerSize + dataSize;

  while (pos < end) {
    const header = bytes[pos]!;
    pos += 1;
    expect(header & 0x80, 'compressed-timestamp headers are not emitted').toBe(0);
    const local = header & 0x0f;

    if ((header & 0x40) !== 0) {
      expect(header & 0x20, 'developer fields are not emitted').toBe(0);
      pos += 1; // reserved
      expect(bytes[pos], 'architecture must be little-endian').toBe(0);
      pos += 1;
      const global = view.getUint16(pos, true);
      pos += 2;
      const count = bytes[pos]!;
      pos += 1;
      const fields: FieldDef[] = [];
      for (let i = 0; i < count; i++) {
        fields.push({ num: bytes[pos]!, size: bytes[pos + 1]!, base: bytes[pos + 2]! });
        pos += 3;
      }
      definitions.set(local, { global, fields });
      continue;
    }

    const def = definitions.get(local);
    if (!def) throw new Error(`data message on undefined local type ${local}`);
    const fields: Record<number, number | string | null> = {};
    for (const field of def.fields) {
      fields[field.num] = readValue(bytes, pos, field);
      pos += field.size;
    }
    messages.push({ global: def.global, fields });
  }

  expect(pos, 'records must end exactly on the declared data size').toBe(end);
  return {
    protocolVersion: bytes[1]!,
    profileVersion: view.getUint16(2, true),
    messages,
  };
}

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

function of(file: DecodedFile, global: number): Message[] {
  return file.messages.filter((message) => message.global === global);
}

function one(file: DecodedFile, global: number): Message {
  const found = of(file, global);
  expect(found, `expected exactly one message ${global}`).toHaveLength(1);
  return found[0]!;
}

const degrees = (semicircles: number): number => semicircles / (2 ** 31 / 180);
const metres = (raw: number): number => raw / 5 - 500;
const number = (value: number | string | null): number => {
  expect(typeof value).toBe('number');
  return value as number;
};

const STARTED_AT = new Date('2026-05-17T06:30:00Z');

function makeFixes(count: number, withHeartRate = false): TrackFix[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i * 10,
    lng: -4.05 + i * 0.0005,
    lat: 53.07 + i * 0.0003,
    eleM: 200 + i * 12,
    ...(withHeartRate ? { heartRate: 118 + (i % 40) } : {}),
  }));
}

function makeRoutePoints(count: number): Array<{ lng: number; lat: number; eleM: number }> {
  // A there-and-back climb, so the highest point is genuinely in the middle.
  return Array.from({ length: count }, (_, i) => {
    const up = i <= (count - 1) / 2;
    const rung = up ? i : count - 1 - i;
    return { lng: -4.05 + i * 0.0004, lat: 53.07 + i * 0.0002, eleM: 300 + rung * 40 };
  });
}

describe('toFitActivity', () => {
  it('writes a well-formed file a reader can walk end to end', () => {
    const file = decodeFit(
      toFitActivity(makeFixes(24), {
        name: 'Snowdon by the Llanberis Path',
        startedAt: STARTED_AT,
        activityType: 'hiking',
      }),
    );

    // Both CRCs and the declared data size are asserted inside `decodeFit`, so reaching
    // here at all is most of the test.
    expect(file.protocolVersion).toBe(0x20);
    expect(file.profileVersion).toBeGreaterThanOrEqual(2000);

    const fileId = one(file, MESG.fileId);
    expect(fileId.fields[0]).toBe(4); // type: activity
    expect(fileId.fields[1]).toBe(255); // manufacturer: development
    expect(number(fileId.fields[4]!)).toBe(
      Math.round((STARTED_AT.getTime() - FIT_EPOCH_MS) / 1000),
    );
  });

  it('orders the messages the way a streaming reader needs them', () => {
    const file = decodeFit(
      toFitActivity(makeFixes(12), {
        name: 'Hike',
        startedAt: STARTED_AT,
        activityType: 'hiking',
      }),
    );
    const order = file.messages.map((message) => message.global);

    // A session that arrives before the records it summarises is the classic way a file
    // imports with zero distance, so the ordering is load-bearing rather than tidy.
    const lastRecord = order.lastIndexOf(MESG.record);
    expect(order.indexOf(MESG.fileId)).toBe(0);
    expect(order.indexOf(MESG.record)).toBeGreaterThan(order.indexOf(MESG.event));
    expect(order.indexOf(MESG.lap)).toBeGreaterThan(lastRecord);
    expect(order.indexOf(MESG.session)).toBeGreaterThan(order.indexOf(MESG.lap));
    expect(order.indexOf(MESG.activity)).toBe(order.length - 1);
  });

  it('brackets the records with a timer start and a stop', () => {
    const fixes = makeFixes(10);
    const file = decodeFit(
      toFitActivity(fixes, { name: 'Hike', startedAt: STARTED_AT, activityType: 'hiking' }),
    );
    const events = of(file, MESG.event);

    expect(events).toHaveLength(2);
    expect(events[0]!.fields[0]).toBe(0); // event: timer
    expect(events[0]!.fields[1]).toBe(0); // event_type: start
    expect(events[1]!.fields[1]).toBe(4); // event_type: stop_all
    // The stop carries the last fix's time, not the first's — a stop that lands before the
    // final record makes a device discard the tail of the hike.
    expect(number(events[1]!.fields[253]!) - number(events[0]!.fields[253]!)).toBe(
      fixes[fixes.length - 1]!.t,
    );
  });

  it('round-trips position, altitude and time on every fix', () => {
    const fixes = makeFixes(20);
    const records = of(
      decodeFit(
        toFitActivity(fixes, { name: 'Hike', startedAt: STARTED_AT, activityType: 'hiking' }),
      ),
      MESG.record,
    );

    expect(records).toHaveLength(fixes.length);
    records.forEach((record, i) => {
      const fix = fixes[i]!;
      // Semicircles resolve to about 8 mm, so anything past the seventh decimal is the
      // format's floor rather than an encoder error.
      expect(degrees(number(record.fields[0]!))).toBeCloseTo(fix.lat, 6);
      expect(degrees(number(record.fields[1]!))).toBeCloseTo(fix.lng, 6);
      // Altitude has a scale of 5, so a fifth of a metre is exact.
      expect(metres(number(record.fields[2]!))).toBeCloseTo(fix.eleM!, 1);
      expect(number(record.fields[253]!)).toBe(
        Math.round((STARTED_AT.getTime() - FIT_EPOCH_MS) / 1000) + fix.t,
      );
    });
  });

  it('carries a distance series that agrees with the summary at the last point', () => {
    // The reason `fixDistancesM` exists. A watch shows both the series and the session
    // total; computing them two different ways puts a visible disagreement on the device
    // that neither number is wrong enough to explain.
    const fixes = makeFixes(30);
    const file = decodeFit(
      toFitActivity(fixes, { name: 'Hike', startedAt: STARTED_AT, activityType: 'hiking' }),
    );
    const records = of(file, MESG.record);
    const distances = records.map((record) => number(record.fields[5]!) / 100);

    expect(distances[0]).toBe(0);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]!).toBeGreaterThan(distances[i - 1]!);
    }
    const stats = summariseTrack(fixes);
    expect(distances[distances.length - 1]!).toBeCloseTo(stats.distanceM, 1);
    expect(number(one(file, MESG.session).fields[9]!) / 100).toBeCloseTo(stats.distanceM, 1);
  });

  it('reports the same totals the product reports', () => {
    const fixes = makeFixes(40);
    const stats = summariseTrack(fixes);
    const file = decodeFit(
      toFitActivity(fixes, { name: 'Hike', startedAt: STARTED_AT, activityType: 'hiking' }),
    );

    const session = one(file, MESG.session);
    expect(number(session.fields[7]!) / 1000).toBeCloseTo(stats.elapsedTimeS, 3);
    expect(number(session.fields[8]!) / 1000).toBeCloseTo(stats.movingTimeS, 3);
    expect(number(session.fields[22]!)).toBe(Math.round(stats.gainM));
    expect(number(session.fields[23]!)).toBe(Math.round(stats.lossM));
    expect(session.fields[26]).toBe(1); // num_laps
    expect(session.fields[5]).toBe(17); // sport: hiking

    // The lap is the session, for a single-lap recording. A device that shows lap splits
    // and a device that shows the summary must not disagree.
    const lap = one(file, MESG.lap);
    expect(lap.fields[9]).toBe(session.fields[9]);
    expect(lap.fields[21]).toBe(session.fields[22]);
    expect(lap.fields[254]).toBe(0); // message_index
  });

  it('maps our activity types onto sports a device understands', () => {
    const sportOf = (activityType: Parameters<typeof toFitActivity>[1]['activityType']) => {
      const session = one(
        decodeFit(toFitActivity(makeFixes(4), { name: 'x', startedAt: STARTED_AT, activityType })),
        MESG.session,
      );
      return { sport: session.fields[5], subSport: session.fields[6] };
    };

    // The pairs where sub_sport is the whole distinction: a device computes pace, ascent
    // and recovery differently for trail and road, and `generic` gets none of it.
    expect(sportOf('trail_running')).toEqual({ sport: 1, subSport: 3 });
    expect(sportOf('road_biking')).toEqual({ sport: 2, subSport: 7 });
    expect(sportOf('mountain_biking')).toEqual({ sport: 2, subSport: 8 });
    // Nothing in FIT is a scramble; mountaineering is the nearest thing that handles the
    // ascent sensibly, which beats a `generic` that handles nothing.
    expect(sportOf('scrambling').sport).toBe(16);
    expect(sportOf('backpacking').sport).toBe(17);
  });

  it('includes heart rate only when the hike actually recorded it', () => {
    const withHr = of(
      decodeFit(
        toFitActivity(makeFixes(12, true), {
          name: 'x',
          startedAt: STARTED_AT,
          activityType: 'hiking',
        }),
      ),
      MESG.record,
    );
    expect(withHr[0]!.fields[3]).toBe(118);
    expect(
      number(
        one(
          decodeFit(
            toFitActivity(makeFixes(12, true), {
              name: 'x',
              startedAt: STARTED_AT,
              activityType: 'hiking',
            }),
          ),
          MESG.session,
        ).fields[17]!,
      ),
    ).toBeGreaterThan(118); // max_heart_rate

    // A phone-recorded hike has no strap. Defining the field and writing 0xFF on every
    // record would be legal and would make a device show a flat invalid trace, so the
    // field is left out of the definition entirely.
    const without = of(
      decodeFit(
        toFitActivity(makeFixes(12), {
          name: 'x',
          startedAt: STARTED_AT,
          activityType: 'hiking',
        }),
      ),
      MESG.record,
    );
    expect(without[0]!.fields).not.toHaveProperty('3');
  });

  it('writes a local timestamp only when the offset is known', () => {
    const withoutOffset = one(
      decodeFit(
        toFitActivity(makeFixes(6), {
          name: 'x',
          startedAt: STARTED_AT,
          activityType: 'hiking',
        }),
      ),
      MESG.activity,
    );
    // Absent from the definition, not written as the invalid sentinel: a reader with no
    // local timestamp shows UTC, and a reader that forgets to check invalid on this field
    // reads 0xFFFFFFFF seconds past 1989 and shows the hike happening in 2126.
    expect(withoutOffset.fields).not.toHaveProperty('5');

    const withOffset = one(
      decodeFit(
        toFitActivity(makeFixes(6), {
          name: 'x',
          startedAt: STARTED_AT,
          activityType: 'hiking',
          utcOffsetS: 2 * 3600,
        }),
      ),
      MESG.activity,
    );
    expect(number(withOffset.fields[5]!) - number(withOffset.fields[253]!)).toBe(7200);
  });

  it('still produces a readable file for an empty or single-fix recording', () => {
    // Downloads must not throw on a recording that never got a fix — a hike that started
    // indoors and was abandoned is a real row in the table.
    const empty = decodeFit(
      toFitActivity([], { name: 'x', startedAt: STARTED_AT, activityType: 'hiking' }),
    );
    expect(of(empty, MESG.record)).toHaveLength(0);
    expect(number(one(empty, MESG.session).fields[9]!)).toBe(0);
    // Written as invalid rather than as 0°N 0°E in the Gulf of Guinea.
    expect(one(empty, MESG.lap).fields[3]).toBeNull();

    const single = decodeFit(
      toFitActivity(makeFixes(1), { name: 'x', startedAt: STARTED_AT, activityType: 'hiking' }),
    );
    expect(of(single, MESG.record)).toHaveLength(1);
    expect(number(one(single, MESG.session).fields[9]!)).toBe(0);
    expect(degrees(number(one(single, MESG.lap).fields[3]!))).toBeCloseTo(53.07, 6);
  });

  it('drops the fixes cleanFixes would drop', () => {
    const fixes = makeFixes(10);
    const noisy: TrackFix[] = [
      ...fixes.slice(0, 5),
      { t: 45, lng: 12.5, lat: 41.9, eleM: 20 }, // a teleport to Rome
      { ...fixes[5]!, accuracyM: 400 }, // a fix too vague to be a position
      ...fixes.slice(6),
    ];

    const records = of(
      decodeFit(toFitActivity(noisy, { name: 'x', startedAt: STARTED_AT, activityType: 'hiking' })),
      MESG.record,
    );
    expect(records).toHaveLength(9);
    for (const record of records) {
      expect(degrees(number(record.fields[1]!))).toBeLessThan(0); // still in Wales
    }
  });
});

const CREATED_AT = new Date('2026-04-02T09:00:00Z');

describe('toFitCourse', () => {
  it('writes a course file with the name and capabilities a device needs', () => {
    const file = decodeFit(
      toFitCourse(makeRoutePoints(21), {
        name: 'Cwm Idwal',
        activityType: 'hiking',
        createdAt: CREATED_AT,
        estimatedTimeS: 5400,
      }),
    );

    expect(one(file, MESG.fileId).fields[0]).toBe(6); // type: course
    const course = one(file, MESG.course);
    expect(course.fields[5]).toBe('Cwm Idwal');
    expect(course.fields[4]).toBe(17); // sport: hiking
    // processed | valid | time | distance | position | navigation. Without `navigation` a
    // Garmin loads the line and offers no turn prompts.
    expect(course.fields[6]).toBe(0x21f);
  });

  it('carries a lap, because several Garmin models will not start a course without one', () => {
    const file = decodeFit(
      toFitCourse(makeRoutePoints(15), {
        name: 'x',
        activityType: 'hiking',
        createdAt: CREATED_AT,
        estimatedTimeS: 3600,
      }),
    );
    const lap = one(file, MESG.lap);
    const records = of(file, MESG.record);

    expect(number(lap.fields[7]!) / 1000).toBe(3600);
    expect(number(lap.fields[9]!) / 100).toBeCloseTo(
      number(records[records.length - 1]!.fields[5]!) / 100,
      1,
    );
    expect(number(lap.fields[21]!)).toBeGreaterThan(0); // total_ascent
    expect(number(lap.fields[22]!)).toBeGreaterThan(0); // total_descent
  });

  it('paces the virtual partner by the planner estimate, spread by distance', () => {
    const points = makeRoutePoints(21);
    const file = decodeFit(
      toFitCourse(points, {
        name: 'x',
        activityType: 'hiking',
        createdAt: CREATED_AT,
        estimatedTimeS: 7200,
      }),
    );
    const records = of(file, MESG.record);
    const times = records.map((record) => number(record.fields[253]!));

    expect(times[0]).toBe(Math.round((CREATED_AT.getTime() - FIT_EPOCH_MS) / 1000));
    expect(times[times.length - 1]! - times[0]!).toBe(7200);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  it('falls back to a hiking pace when the route has no estimate', () => {
    const file = decodeFit(
      toFitCourse(makeRoutePoints(11), {
        name: 'x',
        activityType: 'hiking',
        createdAt: CREATED_AT,
        estimatedTimeS: null,
      }),
    );
    const lap = one(file, MESG.lap);
    const distanceM = number(lap.fields[9]!) / 100;
    const durationS = number(lap.fields[7]!) / 1000;

    // 1.1 m/s. A constant is a poor virtual partner, but a course with no clock at all
    // gives a device nothing to draw the pace band from.
    expect(distanceM / durationS).toBeCloseTo(1.1, 2);
  });

  it('marks the start, the high point and the finish', () => {
    const points = makeRoutePoints(21);
    const marks = of(
      decodeFit(
        toFitCourse(points, {
          name: 'x',
          activityType: 'hiking',
          createdAt: CREATED_AT,
          estimatedTimeS: 3600,
        }),
      ),
      MESG.coursePoint,
    );

    expect(marks.map((mark) => mark.fields[6])).toEqual(['Start', 'High point', 'Finish']);
    expect(marks.map((mark) => mark.fields[254])).toEqual([0, 1, 2]);
    expect(marks[1]!.fields[5]).toBe(1); // type: summit
    // The summit marker sits on the actual highest point, which is what puts it in the
    // right place on the watch's climb graph rather than halfway along the line.
    const highest = points.reduce((best, p, i) => (p.eleM > points[best]!.eleM ? i : best), 0);
    expect(degrees(number(marks[1]!.fields[2]!))).toBeCloseTo(points[highest]!.lat, 6);
  });

  it('omits the summit marker when the high point is an endpoint', () => {
    // A pure ascent: the finish *is* the high point, and two markers on one pixel is worse
    // than one marker.
    const climb = Array.from({ length: 12 }, (_, i) => ({
      lng: -4.05 + i * 0.0004,
      lat: 53.07,
      eleM: 300 + i * 30,
    }));
    const marks = of(
      decodeFit(
        toFitCourse(climb, {
          name: 'x',
          activityType: 'hiking',
          createdAt: CREATED_AT,
          estimatedTimeS: 1800,
        }),
      ),
      MESG.coursePoint,
    );
    expect(marks.map((mark) => mark.fields[6])).toEqual(['Start', 'Finish']);
  });

  it('truncates a long name on a character boundary', () => {
    // A name cut mid-sequence is not UTF-8 at all, and the watch shows a replacement
    // character where the last letter of the route should be.
    const name = `Bwlch ${'ŵ'.repeat(60)}`;
    const course = one(
      decodeFit(
        toFitCourse(makeRoutePoints(5), {
          name,
          activityType: 'hiking',
          createdAt: CREATED_AT,
          estimatedTimeS: 600,
        }),
      ),
      MESG.course,
    );

    const written = course.fields[5];
    expect(typeof written).toBe('string');
    expect(written as string).not.toContain('�');
    expect(name.startsWith(written as string)).toBe(true);
  });

  it('produces a readable file for a route with no points', () => {
    const file = decodeFit(
      toFitCourse([], { name: 'x', activityType: 'hiking', createdAt: CREATED_AT }),
    );
    expect(of(file, MESG.record)).toHaveLength(0);
    expect(of(file, MESG.coursePoint)).toHaveLength(0);
    expect(number(one(file, MESG.lap).fields[9]!)).toBe(0);
  });
});

describe('encodeBase64', () => {
  it('agrees with a reference implementation, including on the padding cases', () => {
    // Hand-rolled because Hermes has no Buffer, which makes it exactly the sort of code
    // that is quietly wrong on the last one or two bytes.
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 255, 1024]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('survives a whole activity file', () => {
    const bytes = toFitActivity(makeFixes(50), {
      name: 'x',
      startedAt: STARTED_AT,
      activityType: 'hiking',
    });
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('fitCrc16', () => {
  it('is the CRC the format specifies', () => {
    // FIT's CRC is CRC-16/ARC — reflected 0x8005, zero init, no final xor. Two anchors: the
    // empty run, and the standard "123456789" check vector for that algorithm.
    expect(fitCrc16(new Uint8Array(0))).toBe(0);
    expect(fitCrc16(new TextEncoder().encode('123456789'))).toBe(0xbb3d);
  });

  it('changes when any byte changes', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
    const original = fitCrc16(bytes);
    for (const index of [0, 31, 63]) {
      const mutated = Uint8Array.from(bytes);
      mutated[index] = (mutated[index]! ^ 0x01) & 0xff;
      expect(fitCrc16(mutated)).not.toBe(original);
    }
  });
});
