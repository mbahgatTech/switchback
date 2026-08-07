/**
 * Development seed — recorded activity, so the heatmap has something to aggregate.
 *
 * The heatmap publishes a cell only once `HEATMAP_MIN_HIKERS` separate accounts have hiked
 * through it. Seeding hikers is how you see the populated state; lowering k is not.
 *
 *     npm run db:seed:tracks
 *     npm run db:seed:tracks -- --reset
 *
 * Tracks follow real ingested geometry, so the wash lands on ground that has paths on it —
 * the only way to see where the wash and the trail lines disagree.
 */
import { ActivityType, Visibility, prisma, writeActivityGeometry } from '@switchback/db';
import { HEATMAP_MIN_HIKERS } from '@switchback/core';
import type { LngLat } from '@switchback/core';
import { cumulativeDistancesM, lineLengthM, resampleLine } from '@switchback/geo';
import { looksLikeHostedDatabase } from './local-database';

/** Stamped on every row this script writes, so `--reset` can find them and nothing else. */
const DEVICE = 'seed-tracks';

/** Deterministic, so two runs produce the same map. Mulberry32, as in the review seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same six regulars the review seed creates, matched on email so the rows are shared. */
const HIKERS: ReadonlyArray<readonly [username: string, name: string]> = [
  ['gritstone', 'Ada Renshaw'],
  ['coldbeck', 'Tomás Guerrero'],
  ['slabfoot', 'Nkechi Obi'],
  ['lateglacial', 'Ingrid Sørhus'],
  ['foulweather', 'Rafiq Mansour'],
  ['onemoreridge', 'Bea Kowalczyk'],
];

/**
 * Where to seed. The heatmap is read one viewport at a time, so a corpus spread over three
 * continents would demonstrate nothing; these are the two areas ingest has actually filled,
 * each about one screen wide at the zoom the layer is useful at.
 *
 * Neither is inside the Seattle fallback view (`apps/web/src/lib/place.ts`), so a reader who
 * switches the layer on from the front page sees an empty overlay until they pan. Closing that
 * needs a third box in the I-90 corridor, once the pipeline has filled it with trails.
 */
const AREAS: ReadonlyArray<{ name: string; bbox: readonly [number, number, number, number] }> = [
  { name: 'Snowdon', bbox: [-4.25, 52.95, -3.85, 53.2] },
  { name: 'Mountain Loop', bbox: [-121.75, 47.85, -121.25, 48.2] },
];

/**
 * Recordings per trail in an area, busiest first. Steep decay because real traffic is wildly
 * uneven, and the ladder puts at least one trail in each of the five key bands so the legend
 * can be checked band by band. Every entry clears `HEATMAP_MIN_HIKERS`, so nothing seeded vanishes.
 */
const LADDER = [340, 155, 88, 52, 31, 19, 12, 8, 6, 4, 3, 3] as const;

/**
 * The length band worth recording, in metres. The floor follows the layer: the query drops the
 * first and last `HEATMAP_CLIP_M` (250 m) of every track, so a 400 m path contributes nothing.
 * The ceiling is a cost guard — the PCT is in this database at 4,265 km.
 */
const MIN_TRAIL_M = 900;
const MAX_TRAIL_M = 25_000;

/** Roughly one sample every two minutes of hiking. Enough to draw, cheap enough to seed. */
const SAMPLE_SPACING_M = 120;

/** Hiking pace on the flat, in metres per second. Deliberately unhurried. */
const BASE_SPEED_MPS = 1.15;

/**
 * How far a recorded track wanders from the mapped line, in metres. The spread matters more
 * than the magnitude: identical tracks would stack into one ribbon with no width.
 */
const WANDER_M = 9;

/** Rows per `createMany`, so a long trail does not arrive as one enormous statement. */
const SAMPLE_BATCH = 500;

function assertNotProduction(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed with NODE_ENV=production');
  }
  // These rows are *public* recordings attributed to named accounts — the one kind of seed data
  // strangers would see if it reached a live database.
  if (looksLikeHostedDatabase(url) && !process.env.SEED_ALLOW_REMOTE) {
    throw new Error(
      `refusing to seed activity into what looks like a hosted database (${url.replace(
        /:[^:@]*@/u,
        ':***@',
      )}). Set SEED_ALLOW_REMOTE=1 if you really mean it.`,
    );
  }
}

/**
 * Move a point sideways off the line by `offsetM`, plus a little along-track slop. The offset is
 * perpendicular to the local heading because that is what GPS error on a path looks like. The
 * longitude term divides by cos(lat) so a metre stays a metre at any latitude.
 */
function nudge(point: LngLat, heading: LngLat, offsetM: number, jitterM: number): LngLat {
  const [lng, lat] = point;
  const mPerDegLat = 111_320;
  const mPerDegLng = Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));

  const dx = (heading[0] - lng) * mPerDegLng;
  const dy = (heading[1] - lat) * mPerDegLat;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  // Perpendicular is the along-track vector turned ninety degrees.
  const eastM = -uy * offsetM + ux * jitterM;
  const northM = ux * offsetM + uy * jitterM;

  return [lng + eastM / mPerDegLng, lat + northM / mPerDegLat];
}

interface Fix {
  t: number;
  lng: number;
  lat: number;
  eleM: number | null;
}

interface Track {
  fixes: Fix[];
  distanceM: number;
  gainM: number;
  lossM: number;
  movingS: number;
  elapsedS: number;
}

/** The trail's own profile, as a function of distance along it. */
type Elevation = (distM: number) => number | null;

function elevationReader(points: ReadonlyArray<{ distM: number; eleM: number }>): Elevation {
  if (points.length === 0) return () => null;
  return (distM) => {
    // The profile is resampled at a fixed interval, so the index is arithmetic. Clamped because
    // a wandered track is fractionally longer than the line it followed.
    const spacing =
      points.length > 1 ? (points.at(-1)!.distM - points[0]!.distM) / (points.length - 1) : 1;
    const index = Math.round((distM - points[0]!.distM) / (spacing || 1));
    return points[Math.min(points.length - 1, Math.max(0, index))]?.eleM ?? null;
  };
}

/**
 * One hiker's recording of one trail. Wander gives the aggregate its width; the trim starts and
 * ends the track part-way along, so identical endpoints do not make the 250 m endpoint clip look
 * like it is cutting a clean line; pace varies so derived times differ.
 */
function buildTrack(line: readonly LngLat[], elevationAt: Elevation, random: () => number): Track {
  const total = lineLengthM(line);
  const trimStart = total * (0.01 + random() * 0.05);
  const trimEnd = total * (0.01 + random() * 0.05);

  const dense = resampleLine(line, SAMPLE_SPACING_M);
  const along = cumulativeDistancesM(dense);
  const speed = BASE_SPEED_MPS * (0.78 + random() * 0.5);

  // A slow sinusoid rather than per-point noise: independent jitter has no shape, and many such
  // tracks aggregate to a blur with a hole down the middle.
  const phase = random() * Math.PI * 2;
  const period = 240 + random() * 400;
  const amplitude = WANDER_M * (0.4 + random() * 0.9);

  const fixes: Fix[] = [];
  let previousT = 0;

  for (const [index, point] of dense.entries()) {
    const s = along[index] ?? 0;
    if (s < trimStart || s > total - trimEnd) continue;

    const next = dense[index + 1] ?? dense[index - 1] ?? point;
    const [lng, lat] = nudge(
      point,
      next,
      Math.sin(phase + s / period) * amplitude,
      (random() - 0.5) * 6,
    );

    const t = Math.round(s / speed);
    // `t` is unique per activity by database constraint, and rounding can collide on a
    // near-duplicate vertex. Stepping past the previous value costs one second of accuracy.
    const stamped = t <= previousT ? previousT + 1 : t;
    previousT = stamped;

    fixes.push({ t: stamped, lng, lat, eleM: elevationAt(s) });
  }

  let gainM = 0;
  let lossM = 0;
  for (const [index, fix] of fixes.entries()) {
    const previous = fixes[index - 1];
    if (!previous || previous.eleM === null || fix.eleM === null) continue;
    const step = fix.eleM - previous.eleM;
    if (step > 0) gainM += step;
    else lossM -= step;
  }

  const movingS = fixes.at(-1)?.t ?? 0;
  return {
    fixes,
    distanceM: lineLengthM(fixes.map((fix) => [fix.lng, fix.lat] as LngLat)),
    gainM,
    lossM,
    movingS,
    // Elapsed exceeds moving time by a rest fraction: identical moving and elapsed times read
    // as a bug in the recorder.
    elapsedS: Math.round(movingS * (1.04 + random() * 0.18)),
  };
}

/** A start time, days back, at a plausible hour. */
function startedAt(random: () => number): Date {
  const at = new Date(Date.now() - Math.floor(random() * 540) * 86_400_000);
  at.setHours(6 + Math.floor(random() * 9), Math.floor(random() * 60), 0, 0);
  return at;
}

async function reset(): Promise<void> {
  // Matched on the device stamp alone, never on the seeded accounts: `seed-reviews.ts` owns
  // those users, and deleting them here would take every seeded review with them.
  const removed = await prisma.activity.deleteMany({ where: { device: DEVICE } });
  console.log(`removed ${removed.count} seeded recordings (their samples went with them)`);
}

async function main(): Promise<void> {
  assertNotProduction();

  if (process.argv.includes('--reset')) {
    await reset();
    return;
  }

  const hikers = await Promise.all(
    HIKERS.map(([username, name]) =>
      prisma.user.upsert({
        where: { email: `${username}@example.invalid` },
        create: {
          email: `${username}@example.invalid`,
          name,
          username,
          bio: 'Seeded account for local development.',
        },
        update: {},
        select: { id: true },
      }),
    ),
  );

  if (hikers.length < HEATMAP_MIN_HIKERS) {
    throw new Error(`need at least ${HEATMAP_MIN_HIKERS} accounts to clear the privacy floor`);
  }

  let activities = 0;
  let samples = 0;

  for (const [areaIndex, area] of AREAS.entries()) {
    const [w, s, e, n] = area.bbox;
    const trails = await prisma.trail.findMany({
      where: {
        lengthM: { gte: MIN_TRAIL_M, lte: MAX_TRAIL_M },
        centroidLng: { gte: w, lte: e },
        centroidLat: { gte: s, lte: n },
      },
      // Popularity first so the busiest ladder rung lands on a trail the rest of the product
      // already calls busy; the rest of the ordering makes it total, so the seed reproduces.
      orderBy: [{ popularity: 'desc' }, { lengthM: 'desc' }, { id: 'asc' }],
      take: LADDER.length,
      select: {
        id: true,
        slug: true,
        name: true,
        geometryJson: true,
        profile: { select: { points: true } },
      },
    });

    if (trails.length === 0) {
      console.log(`${area.name}: no trails ingested here yet — skipping`);
      continue;
    }

    console.log(`\n${area.name}`);

    for (const [index, trail] of trails.entries()) {
      const line = (trail.geometryJson as { coordinates?: LngLat[] } | null)?.coordinates ?? [];
      if (line.length < 2) continue;

      const elevationAt = elevationReader(
        (trail.profile?.points as ReadonlyArray<{ distM: number; eleM: number }> | undefined) ?? [],
      );
      const wanted = LADDER[index] ?? HEATMAP_MIN_HIKERS;

      for (let nth = 0; nth < wanted; nth += 1) {
        // Seeded off area, trail and recording number, so re-running reproduces the same corpus.
        const random = rng(areaIndex * 1_299_721 + index * 104_729 + nth * 7_919 + 17);
        const hiker = hikers[nth % hikers.length]!;

        const track = buildTrack(line, elevationAt, random);
        if (track.fixes.length < 2) continue;

        const started = startedAt(random);
        const ended = new Date(started.getTime() + track.elapsedS * 1_000);

        const activity = await prisma.activity.create({
          data: {
            userId: hiker.id,
            trailId: trail.id,
            name: trail.name,
            activityType: nth % 7 === 0 ? ActivityType.trail_running : ActivityType.hiking,
            // Private recordings are excluded from the aggregate by design.
            visibility: Visibility.public,
            startedAt: started,
            endedAt: ended,
            movingTimeS: track.movingS,
            elapsedTimeS: track.elapsedS,
            distanceM: track.distanceM,
            gainM: track.gainM,
            lossM: track.lossM,
            avgSpeedMps: track.movingS > 0 ? track.distanceM / track.movingS : null,
            geometryJson: {
              type: 'LineString',
              coordinates: track.fixes.map((fix) => [fix.lng, fix.lat]),
            },
            // The heatmap filters on this: an unsynced activity is a partial track and is
            // excluded from every aggregate, so leaving it null makes the seed a no-op.
            syncedAt: new Date(ended.getTime() + 60_000),
            device: DEVICE,
          },
          select: { id: true },
        });

        for (let from = 0; from < track.fixes.length; from += SAMPLE_BATCH) {
          await prisma.activitySample.createMany({
            data: track.fixes.slice(from, from + SAMPLE_BATCH).map((fix) => ({
              activityId: activity.id,
              t: fix.t,
              lng: fix.lng,
              lat: fix.lat,
              eleM: fix.eleM,
            })),
          });
        }

        // The heatmap reads `activities.geom`, never the samples — without this the seed does nothing.
        await writeActivityGeometry(prisma, activity.id, {
          type: 'LineString',
          coordinates: track.fixes.map((fix) => [fix.lng, fix.lat] as LngLat),
        });

        activities += 1;
        samples += track.fixes.length;
      }

      console.log(`  ${trail.slug} — ${LADDER[index] ?? 0}`);
    }
  }

  console.log(
    `\nwrote ${activities} recordings and ${samples} samples across ${hikers.length} accounts`,
  );
  console.log('remove them again with: npm run db:seed:tracks -- --reset');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
