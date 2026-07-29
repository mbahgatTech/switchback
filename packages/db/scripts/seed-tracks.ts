/**
 * Development seed — recorded activity, so the heatmap has something to aggregate.
 *
 * The third seed, and the same principle as the other two. `seed.ts` refuses to invent
 * trails, because a fake trail hides a broken ingest pipeline. `seed-reviews.ts` invents
 * people and what they wrote, because writing has no upstream source. This one invents
 * where those people hiked, for the same reason: a GPS track is produced by somebody
 * holding a phone on a hillside, and a local database therefore has none.
 *
 * That absence is not cosmetic here. The activity heatmap publishes a cell only once
 * `HEATMAP_MIN_HIKERS` separate accounts have hiked through it — the load-bearing privacy
 * control, and the one thing in the feature that must never be relaxed to make a screenshot
 * look better. A database with one hiker in it renders a correct, completely blank overlay,
 * and neither the populated state nor the "N cells hidden" state can be looked at. Seeding
 * hikers is the honest way to see the feature; lowering k is not.
 *
 *     npm run db:seed:tracks
 *     npm run db:seed:tracks -- --reset
 *
 * Tracks follow real ingested geometry rather than invented lines, so the wash lands on
 * ground that actually has paths on it. That is the only way to judge the thing this layer
 * exists to show: where the wash and the trail lines *disagree*.
 */
import { ActivityType, Visibility, prisma, writeActivityGeometry } from '@switchback/db';
import { HEATMAP_MIN_HIKERS } from '@switchback/core';
import type { LngLat } from '@switchback/core';
import { cumulativeDistancesM, lineLengthM, resampleLine } from '@switchback/geo';

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
 * Where to seed, rather than "the busiest trails in the database".
 *
 * The heatmap is read one viewport at a time, so a corpus spread evenly over three
 * continents would put two or three recordings in every view and demonstrate nothing. These
 * are the two areas the ingest pipeline has actually filled: Snowdon, which is where
 * `/explore` opens, and the Mountain Loop, which is where the trails people search for by
 * name in this database happen to be. Seeding both means the layer is visible on arrival
 * *and* at the place a reader is most likely to navigate to next.
 *
 * The boxes are deliberately about one screen wide at the zoom the layer is useful at.
 */
const AREAS: ReadonlyArray<{ name: string; bbox: readonly [number, number, number, number] }> = [
  { name: 'Snowdon', bbox: [-4.25, 52.95, -3.85, 53.2] },
  { name: 'Mountain Loop', bbox: [-121.75, 47.85, -121.25, 48.2] },
];

/**
 * How many recordings each trail in an area gets, busiest first.
 *
 * A steep decay rather than a flat number, because the whole point of the layer is that
 * traffic is wildly uneven — a flat twenty per trail would paint every path the same shade
 * and show nothing a trail index does not already say. The ladder puts at least one trail in
 * each of the five bands (3, 10, 30, 100, 300), so the key can be checked against the map
 * band by band rather than taken on trust.
 *
 * It is also, roughly, true. On Snowdon the Llanberis Path carries an order of magnitude more
 * people than the Watkin, and the quarry tramways at the bottom of this list carry almost
 * nobody. A uniform seed would be both duller and less honest.
 *
 * Every entry clears `HEATMAP_MIN_HIKERS`; a trail seeded below k would vanish, and an
 * invisible trail in a seed reads as a bug rather than as the floor doing its job.
 */
const LADDER = [340, 155, 88, 52, 31, 19, 12, 8, 6, 4, 3, 3] as const;

/**
 * The length band worth recording, in metres.
 *
 * The floor is set by the layer itself: the query drops the first and last
 * `HEATMAP_CLIP_M` (250 m) of every track before it aggregates, so a 600 m path contributes
 * one cell and a 400 m path contributes nothing. The ceiling is a cost guard — the Pacific
 * Crest Trail is in this database at 4,265 km, and three hundred recordings of it at one
 * sample per 120 m would be ten million rows to demonstrate a colour ramp.
 */
const MIN_TRAIL_M = 900;
const MAX_TRAIL_M = 25_000;

/** Roughly one sample every two minutes of hiking. Enough to draw, cheap enough to seed. */
const SAMPLE_SPACING_M = 120;

/** Hiking pace on the flat, in metres per second. Deliberately unhurried. */
const BASE_SPEED_MPS = 1.15;

/**
 * How far a recorded track wanders from the mapped line, in metres.
 *
 * Consumer GPS under trees is good to about five metres and much worse in a gorge, and the
 * spread matters more than the magnitude: identical tracks would stack into one perfect
 * ribbon, and the aggregate would have no width — which is exactly what a heatmap of real
 * data does not look like.
 */
const WANDER_M = 9;

/** Rows per `createMany`, so a long trail does not arrive as one enormous statement. */
const SAMPLE_BATCH = 500;

function assertNotProduction(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed with NODE_ENV=production');
  }
  // The same refusal as the review seed, and it matters more here: these rows are *public*
  // recordings attributed to named accounts, which is the one kind of seed data that would
  // be visible to strangers if it ever reached a live database.
  if (/neon\.tech|amazonaws\.com|supabase\.co/u.test(url) && !process.env.SEED_ALLOW_REMOTE) {
    throw new Error(
      `refusing to seed activity into what looks like a hosted database (${url.replace(
        /:[^:@]*@/u,
        ':***@',
      )}). Set SEED_ALLOW_REMOTE=1 if you really mean it.`,
    );
  }
}

/**
 * Move a point sideways off the line by `offsetM`, plus a little along-track slop.
 *
 * The lateral offset is taken perpendicular to the local heading rather than in a random
 * direction, because that is what GPS error on a path actually looks like: a track drifts off
 * the side of the trail and comes back, it does not teleport ahead of itself. The longitude
 * term divides by cos(lat) so a fixed offset in metres stays a fixed offset on the ground
 * rather than shrinking to nothing at the equator and exploding in Svalbard.
 */
function nudge(point: LngLat, heading: LngLat, offsetM: number, jitterM: number): LngLat {
  const [lng, lat] = point;
  const mPerDegLat = 111_320;
  const mPerDegLng = Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));

  // Unit vector along the line, in metres.
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
    // The profile is resampled at a fixed interval, so the index is arithmetic rather than a
    // search. Clamped at both ends because a wandered track is fractionally longer than the
    // line it followed and would otherwise run off the end of the array.
    const spacing =
      points.length > 1 ? (points.at(-1)!.distM - points[0]!.distM) / (points.length - 1) : 1;
    const index = Math.round((distM - points[0]!.distM) / (spacing || 1));
    return points[Math.min(points.length - 1, Math.max(0, index))]?.eleM ?? null;
  };
}

/**
 * One hiker's recording of one trail.
 *
 * Three things vary per recording, and each is there for a reason a screenshot would
 * otherwise expose. The **wander** gives the aggregate its width, as above. The **trim**
 * starts and ends the track a little way along the line, because real recordings begin in a
 * car park and end when somebody remembers to press stop — identical endpoints would make the
 * 250 m endpoint clip look like it was cutting a clean line rather than protecting one. The
 * **pace** varies so the derived times are not all the same number.
 */
function buildTrack(line: readonly LngLat[], elevationAt: Elevation, random: () => number): Track {
  const total = lineLengthM(line);
  const trimStart = total * (0.01 + random() * 0.05);
  const trimEnd = total * (0.01 + random() * 0.05);

  const dense = resampleLine(line, SAMPLE_SPACING_M);
  const along = cumulativeDistancesM(dense);
  const speed = BASE_SPEED_MPS * (0.78 + random() * 0.5);

  // A slow sinusoid rather than per-point noise. A track that jitters independently at every
  // sample has no shape, and the aggregate of many such tracks is a blur with a hole down the
  // middle. A drift with a period of a few hundred metres is what a real one does.
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
    // near-duplicate vertex. Stepping past the previous value costs one second of accuracy
    // and removes the only way this script can fail on a real trail.
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
    // Elapsed exceeds moving time by a rest fraction. The map does not care, but an activity
    // page showing identical moving and elapsed times looks like a bug in the recorder.
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
  // Matched on the device stamp alone, not on the seeded accounts. `seed-reviews.ts` owns
  // those users and owns deleting them; a reset here that took them with it would wipe every
  // seeded review as collateral, and one that missed a track recorded under a real account
  // during testing would leave it behind.
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
      // already calls busy, then length, so the order is total and the seed reproducible.
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
        // Seeded off the area, the trail and the recording number, so re-running the script
        // reproduces the identical corpus rather than layering a second one on top of it.
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
            // Public, because a private recording is excluded from the aggregate by design —
            // a seed of private tracks would produce the same blank map it is meant to fix.
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
            // The flag the heatmap filters on: an unsynced activity is a partial track and is
            // excluded from every aggregate. Leaving it null would make this a silent no-op.
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

        // The heatmap reads `activities.geom` and never the samples, so this line is the one
        // that makes the seed do anything at all.
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
