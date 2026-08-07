/**
 * Fixtures for the browser suite: the two trails `e2e/` opens by slug that no ingested tile holds.
 * Offline and deterministic, under reserved slugs — read the note below before adding to this file.
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
import { looksLikeHostedDatabase } from './local-database';

/**
 * WHY THERE IS INVENTED GEOMETRY HERE, when `seed.ts` refuses to invent any.
 *
 * `seed.ts` is right for the development seed: a fake trail there would hide a broken pipeline,
 * because the pipeline is what the explore sheet is looking at. These two are different. CI makes
 * exactly one Overpass query — one z9 tile over Vesper Peak, for fair use, see the note at the
 * top of `.github/workflows/ci.yml` — and two specs open trails that tile does not contain, so
 * they failed on every run. Neither spec is about the pipeline: one is about what a browser draws
 * when an image file 404s, the other about SVG labels overprinting. Fixtures answer both, and
 * answer them identically on a runner and on a laptop, which is what those specs were not doing.
 *
 * The slugs are reserved — no OSM name slugifies to `fixture-…` — so nothing written here can
 * land on, or be landed on by, a trail the pipeline produced. The specs that *are* about the
 * pipeline still read the real ingested Vesper Peak sheet and are untouched.
 */

/** Spacing rule copied from `pipeline.ts`, so a fixture profile is shaped like a real one. */
const PROFILE_SPACING_M = 25;
const MAX_PROFILE_POINTS = 6_000;

/** Vertices `geometryJson` may carry, as in `renderGeometry`. */
const MAX_RENDER_VERTICES = 3_000;

/**
 * A trail described by its ends and two curves: where the line goes, and where the ground does.
 * Everything stored is measured off the result rather than stated here, so the stats, the axis
 * and the section cannot disagree with the line they are drawn from.
 */
interface Shape {
  slug: string;
  name: string;
  description: string;
  from: LngLat;
  to: LngLat;
  /** Serpentine across the straight run: amplitude in degrees, and cycles end to end. */
  wobbleDeg: number;
  wobbleCycles: number;
  lowEleM: number;
  peakEleM: number;
  endEleM: number;
  /** Where the high point falls, as a fraction of the length. */
  highAt: number;
  /** Undulation after the high point: metres trough to crest, and cycles over the remainder. */
  rollM: number;
  rollCycles: number;
  /** Photographs to hang on it. */
  photographs: number;
}

/**
 * New Zealand, deliberately: every other spec in the suite looks at Vesper Peak or Snowdon, and a
 * fixture inside one of those viewports would change what a map spec counts.
 */
const SHAPES: readonly Shape[] = [
  {
    slug: 'fixture-photographed-trail',
    name: 'Photographed trail fixture',
    description:
      'A browser-suite fixture. Its twelve photographs are rows with no files behind them, which is the state the gallery spec is about.',
    from: [175.58, -39.16],
    to: [175.68, -39.1],
    wobbleDeg: 0.004,
    wobbleCycles: 6,
    lowEleM: 760,
    peakEleM: 1_860,
    endEleM: 1_820,
    highAt: 0.85,
    rollM: 40,
    rollCycles: 3,
    photographs: 12,
  },
  {
    /**
     * The collar spec's trail. Its high point is 7% along, and that fraction is the whole
     * condition: `placeCallouts` works in viewBox x-units, so what crowds the two weather
     * annotations is where the high point falls in the width, not how many kilometres in it is.
     * Long enough that the arrival clocks are days apart, as they were in the original report.
     */
    slug: 'fixture-early-high-point',
    name: 'Early high point fixture',
    description:
      'A browser-suite fixture. A long through-hike whose high point comes 7% in, where the section’s two weather callouts fight for room.',
    from: [170.6, -43.3],
    to: [172.0, -42.3],
    wobbleDeg: 0.008,
    wobbleCycles: 24,
    lowEleM: 420,
    peakEleM: 2_180,
    endEleM: 640,
    highAt: 0.07,
    rollM: 200,
    rollCycles: 24,
    photographs: 0,
  },
];

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

    const saved = await prisma.photo.upsert({
      where: { source_sourceId_trailId: { source: PhotoSource.wikimedia, sourceId, trailId } },
      create: data,
      update: data,
      select: { id: true },
    });
    ids.push(saved.id);
  }

  await prisma.trail.update({
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

  const trail = await prisma.trail.upsert({
    where: { slug: shape.slug },
    create: { slug: shape.slug, ...row },
    update: row,
    select: { id: true },
  });

  // `geom` is what every spatial query reads and `searchVector` is what search reads; neither is
  // written by the upsert above, and a trail missing them looks fine until something asks.
  await writeTrailGeometry(prisma, {
    trailId: trail.id,
    geometry: { type: 'LineString', coordinates: coords },
    centroid,
  });

  const profileRow = { points: profile, spacingM, highPointIndex: top };
  await prisma.elevationProfile.upsert({
    where: { trailId: trail.id },
    create: { trailId: trail.id, ...profileRow },
    update: profileRow,
  });

  if (shape.photographs > 0) await writeFrames(trail.id, profile, shape.photographs);

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

  console.log('\nthe browser suite can now open both trails. Remove them again with --reset.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
