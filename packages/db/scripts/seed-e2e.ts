/**
 * Writes the browser suite's offline fixture trails. The shapes, and why they are invented, are
 * in `e2e-shapes.ts`; everything here derives a row from one of them.
 */
import { classifyDifficulty } from '@switchback/core';
import type { ElevationPoint, LngLat } from '@switchback/core';
import {
  bboxOf,
  computeTrailStats,
  cumulativeDistancesM,
  highPointIndex,
  lineLengthM,
  resampleLine,
  simplifyLine,
} from '@switchback/geo';
import type { Prisma } from '@switchback/db';
import { ActivityType, PhotoSource, RouteType, prisma, writeTrailGeometry } from '@switchback/db';
import { SHAPES, type Shape } from './e2e-shapes';
import { looksLikeHostedDatabase } from './local-database';

/** Spacing rule copied from `pipeline.ts`, so a fixture profile is shaped like a real one. */
const PROFILE_SPACING_M = 25;
const MAX_PROFILE_POINTS = 6_000;

/** Vertices `geometryJson` may carry, as in `renderGeometry`. */
const MAX_RENDER_VERTICES = 3_000;

function assertNotProduction(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed with NODE_ENV=production');
  }
  // Invented trails are the one kind of seed row that would be indistinguishable from a pipeline
  // failure if it reached a live database.
  if (looksLikeHostedDatabase(url) && !process.env.SEED_ALLOW_REMOTE) {
    throw new Error(
      `refusing to seed fixtures into what looks like a hosted database (${url.replace(
        /:[^:@]*@/u,
        ':***@',
      )}). Set SEED_ALLOW_REMOTE=1 if you really mean it.`,
    );
  }
}

/** As `pipeline.ts`: 25 m until that would blow the point cap, then the next multiple of 25. */
function profileSpacingFor(lengthM: number): number {
  if (lengthM <= MAX_PROFILE_POINTS * PROFILE_SPACING_M) return PROFILE_SPACING_M;
  return Math.ceil(lengthM / MAX_PROFILE_POINTS / PROFILE_SPACING_M) * PROFILE_SPACING_M;
}

/** The line: a straight run between the ends, pushed sideways by a sine so it has real length. */
function serpentine(shape: Shape, steps: number): LngLat[] {
  const [x0, y0] = shape.from;
  const dx = shape.to[0] - x0;
  const dy = shape.to[1] - y0;
  const run = Math.hypot(dx, dy) || 1;
  const [nx, ny] = [-dy / run, dx / run];

  const coords: LngLat[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const off = shape.wobbleDeg * Math.sin(2 * Math.PI * shape.wobbleCycles * t);
    coords.push([x0 + dx * t + nx * off, y0 + dy * t + ny * off]);
  }
  return coords;
}

/**
 * The ground under a point `t` along the trail. The undulation is subtracted and starts at zero,
 * so the high point stays the maximum of the profile however the numbers above are retuned —
 * which matters, because a profile peaking at its trailhead leaves the section one callout.
 */
function elevationAt(shape: Shape, t: number): number {
  if (t <= shape.highAt) {
    return shape.lowEleM + (shape.peakEleM - shape.lowEleM) * (t / shape.highAt);
  }
  const u = (t - shape.highAt) / (1 - shape.highAt);
  const spine = shape.peakEleM - (shape.peakEleM - shape.endEleM) * u;
  return spine - (shape.rollM * (1 - Math.cos(2 * Math.PI * shape.rollCycles * u))) / 2;
}

/** The drawn copy, coarsened until it fits, as `renderGeometry` does it. */
function renderable(coords: readonly LngLat[]): LngLat[] {
  let toleranceM = 5;
  let out = simplifyLine(coords, toleranceM);
  while (out.length > MAX_RENDER_VERTICES && toleranceM < 5_000) {
    toleranceM *= 4;
    out = simplifyLine(coords, toleranceM);
  }
  return out;
}

function build(shape: Shape): { coords: LngLat[]; profile: ElevationPoint[]; spacingM: number } {
  // Fine enough that the resample below is choosing points along the curve, not inventing it.
  const draft = serpentine(shape, 4_000);
  const spacingM = profileSpacingFor(lineLengthM(draft));
  const coords = resampleLine(draft, spacingM);

  const cum = cumulativeDistancesM(coords);
  const totalM = cum[cum.length - 1] ?? 0;
  const profile = coords.map((coord, i) => ({
    distM: Math.round(cum[i]! * 10) / 10,
    eleM: Math.round(elevationAt(shape, totalM === 0 ? 0 : cum[i]! / totalM) * 10) / 10,
    lng: coord[0],
    lat: coord[1],
  }));

  return { coords, profile, spacingM };
}

/** The profile sample nearest a distance along the trail. */
function sampleAt(profile: readonly ElevationPoint[], distM: number): ElevationPoint {
  const spacingM = profile.length > 1 ? profile[1]!.distM - profile[0]!.distM : 1;
  const index = Math.min(profile.length - 1, Math.max(0, Math.round(distM / (spacingM || 1))));
  return profile[index]!;
}

/**
 * Photographs on Commons that are not there. The host is the point: `photographs.spec.ts`
 * intercepts `upload.wikimedia.org` and nothing else, so that is where a seeded frame has to live
 * for a failure to be about photographs rather than about MapLibre's sprites. The paths are
 * Commons-shaped but unresolvable, and carry no licence or source link — a fixture that fetches
 * is not a fixture, and there is no work here to credit.
 */
async function writeFrames(
  tx: Prisma.TransactionClient,
  trailId: string,
  profile: readonly ElevationPoint[],
  count: number,
): Promise<void> {
  const ids: string[] = [];
  const totalM = profile[profile.length - 1]?.distM ?? 0;

  for (let n = 1; n <= count; n += 1) {
    const nth = String(n).padStart(2, '0');
    const sourceId = `browser-suite-fixture-${nth}`;
    // Spread along the trail, so each frame prints the "N km in" line the strip exists for.
    const distM = Math.round((totalM * n) / (count + 1));
    const at = sampleAt(profile, distM);
    const file = `Switchback_browser_suite_fixture_${nth}.jpg`;
    const data = {
      trailId,
      source: PhotoSource.wikimedia,
      sourceId,
      url: `https://upload.wikimedia.org/wikipedia/commons/0/00/${file}`,
      thumbUrl: `https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/${file}/640px-${file}`,
      width: 1_600,
      height: 1_067,
      license: null,
      attribution: 'Browser-suite fixture',
      sourceUrl: null,
      lng: at.lng,
      lat: at.lat,
      distM,
      capturedAt: new Date(Date.UTC(2024, 8, n, 9)),
    };

    const saved = await tx.photo.upsert({
      where: { source_sourceId_trailId: { source: PhotoSource.wikimedia, sourceId, trailId } },
      create: data,
      update: data,
      select: { id: true },
    });
    ids.push(saved.id);
  }

  await tx.trail.update({
    where: { id: trailId },
    data: { photoCount: ids.length, primaryPhotoId: ids[0] ?? null },
  });
}

async function writeFixture(shape: Shape): Promise<void> {
  const { coords, profile, spacingM } = build(shape);
  const stats = computeTrailStats(profile);
  const { difficulty, score } = classifyDifficulty({
    gainM: stats.gainM,
    lengthM: stats.lengthM,
    maxSustainedGrade: stats.maxSustainedGrade,
  });
  const [bboxW, bboxS, bboxE, bboxN] = bboxOf(coords);
  const centroid = coords[Math.floor(coords.length / 2)]!;
  const top = highPointIndex(profile);

  const row = {
    name: shape.name,
    description: shape.description,
    regionName: 'Browser-suite fixture',
    countryCode: 'NZ',
    // No `osmType`/`osmId`: these are not OSM objects, and claiming an id would put a fixture in
    // the way of the real element the next ingest of that area commits.
    geometryJson: {
      type: 'LineString',
      coordinates: renderable(coords),
    } as Prisma.InputJsonValue,
    centroidLng: centroid[0],
    centroidLat: centroid[1],
    bboxW,
    bboxS,
    bboxE,
    bboxN,
    lengthM: stats.lengthM,
    gainM: stats.gainM,
    lossM: stats.lossM,
    minEleM: stats.minEleM,
    maxEleM: stats.maxEleM,
    maxSustainedGrade: stats.maxSustainedGrade,
    estimatedTimeS: stats.estimatedTimeS,
    difficulty,
    difficultyScore: score,
    // Stated rather than classified: `classifyRouteType` would call a serpentine an out-and-back
    // as soon as it doubled back on itself, and mirroring the profile moves the high point.
    routeType: RouteType.point_to_point,
    activityTypes: [ActivityType.hiking],
  };

  // One transaction per fixture, because a half-written one is worse than a missing one: the row
  // alone satisfies `trails.bySlug`, so the suite's "run the seed" message never fires and the
  // specs fail somewhere inside the page render instead. Ctrl-C is the realistic way in.
  await prisma.$transaction(
    async (tx) => {
      const trail = await tx.trail.upsert({
        where: { slug: shape.slug },
        create: { slug: shape.slug, ...row },
        update: row,
        select: { id: true },
      });

      // `geom` is what every spatial query reads and `searchVector` is what search reads; neither
      // is written by the upsert above, and a trail missing them looks fine until something asks.
      await writeTrailGeometry(tx, {
        trailId: trail.id,
        geometry: { type: 'LineString', coordinates: coords },
        centroid,
      });

      const profileRow = { points: profile, spacingM, highPointIndex: top };
      await tx.elevationProfile.upsert({
        where: { trailId: trail.id },
        create: { trailId: trail.id, ...profileRow },
        update: profileRow,
      });

      if (shape.photographs > 0) await writeFrames(tx, trail.id, profile, shape.photographs);
    },
    // The long fixture resamples to a few thousand profile points; the 5 s default is not a
    // budget it reliably fits inside on a cold runner.
    { timeout: 60_000, maxWait: 60_000 },
  );

  const highAt = stats.lengthM > 0 ? (profile[top]!.distM / stats.lengthM) * 100 : 0;
  console.log(
    `${shape.slug.padEnd(28)} ${(stats.lengthM / 1_000).toFixed(1)} km · ↑${stats.gainM} m · ` +
      `high point ${highAt.toFixed(1)}% along · ${profile.length} samples · ` +
      `${shape.photographs} photographs`,
  );
}

async function main(): Promise<void> {
  assertNotProduction();

  const slugs = SHAPES.map((shape) => shape.slug);

  if (process.argv.includes('--reset')) {
    // `Trail.primaryPhotoId` points into `photos`, which cascade off the trail — cleared first so
    // the delete cannot land on its own foreign key.
    await prisma.trail.updateMany({
      where: { slug: { in: slugs } },
      data: { primaryPhotoId: null },
    });
    const removed = await prisma.trail.deleteMany({ where: { slug: { in: slugs } } });
    console.log(
      `removed ${removed.count} fixture trails — photographs and profiles went with them`,
    );
    return;
  }

  for (const shape of SHAPES) await writeFixture(shape);

  console.log('\nthe browser suite can now open these trails. Remove them again with --reset.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
