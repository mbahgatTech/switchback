/**
 * Re-run route-type classification over trails already in the database. The classifier gained
 * `hasImpliedReturnLeg` and `climbsToADeadEnd` after most of the catalogue was ingested, and
 * nothing about a trail changes when our reading of it does, so the staleness sweep will never
 * touch those rows.
 *
 * Re-fetches nothing: both signals are already stored — the mapped ends as `Waypoint` rows,
 * the shape of the climb as the elevation profile and its high-point index.
 *
 *   npx tsx scripts/reclassify-route-types.ts            # report only, changes nothing
 *   npx tsx scripts/reclassify-route-types.ts --apply    # write the corrections
 *
 * Dry run is the default, deliberately: a wrong verdict here doubles every published figure
 * for a trail, so read the sample before believing it.
 */
import type { ElevationPoint, LngLat, SacScale } from '@switchback/core';
import { classifyDifficulty } from '@switchback/core';
import { type Prisma, RouteType, prisma } from '@switchback/db';
import type { PlacedFeature } from '@switchback/geo';
import {
  MAX_SPUR_LENGTH_M,
  MIN_DEAD_END_CLIMB_M,
  MIN_SPUR_LENGTH_M,
  TERMINAL_DESTINATIONS,
  climbsToADeadEnd,
  computeTrailStats,
  hasImpliedReturnLeg,
  isTraverse,
  mirrorProfile,
  namesACircuit,
  namesAThoroughfare,
  terminusKinds,
  terrainFactorFor,
} from '@switchback/geo';

/** How many trails to hold in memory at once. Each carries a profile of up to ~2,000 samples. */
const BATCH = 200;

/** How many corrections per rule to print, so the operator can spot-check before applying. */
const SAMPLE = Number(process.env.SAMPLE ?? 15);

interface Correction {
  id: string;
  slug: string;
  name: string;
  regionName: string | null;
  /** Which rule fired, so the sample below can be read one class of verdict at a time. */
  by: 'terminus' | 'climb' | 'both';
  fromLengthM: number;
  toLengthM: number;
  update: {
    routeType: RouteType;
    lengthM: number;
    gainM: number;
    lossM: number;
    minEleM: number;
    maxEleM: number;
    maxSustainedGrade: number | null;
    estimatedTimeS: number;
    difficulty: ReturnType<typeof classifyDifficulty>['difficulty'];
    difficultyScore: number;
  };
}

/**
 * Does this trail's stored shape imply a return leg nobody drew? Only the two endpoints are
 * read; the one thing the samples between them contribute — where the high point sits — is
 * already stored as `highPointIndex`.
 */
function reclassify(trail: {
  id: string;
  slug: string;
  name: string;
  regionName: string | null;
  lengthM: number;
  surface: string | null;
  sacScale: SacScale | null;
  profile: { points: unknown; highPointIndex: number } | null;
  waypoints: Array<{ kind: string; lng: number; lat: number }>;
}): Correction | null {
  const points = trail.profile?.points as ElevationPoint[] | undefined;
  if (!points || points.length < 2) return null;
  // A trail the mapper called a loop is missing half a circle, not a return leg.
  if (namesACircuit(trail.name)) return null;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const ends: LngLat[] = [
    [first.lng, first.lat],
    [last.lng, last.lat],
  ];

  const placed: PlacedFeature[] = trail.waypoints.map((w) => ({
    at: [w.lng, w.lat],
    kind: w.kind as PlacedFeature['kind'],
  }));

  // The stored length is the one-way figure for a point-to-point trail, which is what the
  // length band in both rules is expressed in.
  const kinds = terminusKinds(ends, placed);
  const byTerminus = hasImpliedReturnLeg(kinds, trail.lengthM);
  const byClimb =
    !isTraverse(kinds) &&
    !namesAThoroughfare(trail.name) &&
    climbsToADeadEnd({
      netGainM: last.eleM - first.eleM,
      dropFromTopM: (points[trail.profile?.highPointIndex ?? 0]?.eleM ?? last.eleM) - last.eleM,
      lengthM: trail.lengthM,
    });
  if (!byTerminus && !byClimb) return null;

  const stats = computeTrailStats(mirrorProfile(points), {
    terrainFactor: terrainFactorFor({ sacScale: trail.sacScale, surface: trail.surface }),
  });
  const difficulty = classifyDifficulty({
    gainM: stats.gainM,
    lengthM: stats.lengthM,
    sacScale: trail.sacScale ?? undefined,
    maxSustainedGrade: stats.maxSustainedGrade ?? undefined,
  });

  return {
    id: trail.id,
    slug: trail.slug,
    name: trail.name,
    regionName: trail.regionName,
    by: byTerminus && byClimb ? 'both' : byTerminus ? 'terminus' : 'climb',
    fromLengthM: trail.lengthM,
    toLengthM: stats.lengthM,
    update: {
      routeType: RouteType.out_and_back,
      ...stats,
      difficulty: difficulty.difficulty,
      difficultyScore: difficulty.score,
    },
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  /**
   * The candidate set, narrowed in SQL rather than in the loop.
   *
   * Every condition here is one the rules would apply anyway, but applying them in SQL means
   * we never load a profile we are about to discard. Without it the script reads 42,000
   * profiles to change a few thousand rows.
   *
   * The `OR` is the two rules' cheapest necessary conditions: something terminal mapped at
   * *some* end (the terminus rule cannot fire without one), or enough climb (the dead-end
   * rule cannot fire below it). `gainM` is cumulative and therefore always at least the net
   * gain `climbsToADeadEnd` actually tests, so filtering on it drops nothing it would keep.
   */
  const where: Prisma.TrailWhereInput = {
    routeType: RouteType.point_to_point,
    lengthM: { gte: MIN_SPUR_LENGTH_M, lte: MAX_SPUR_LENGTH_M },
    OR: [
      { waypoints: { some: { kind: { in: [...TERMINAL_DESTINATIONS] } } } },
      { gainM: { gte: MIN_DEAD_END_CLIMB_M } },
    ],
  };

  const total = await prisma.trail.count({ where });
  console.log(
    `${total} point-to-point trails between ${MIN_SPUR_LENGTH_M} m and ${MAX_SPUR_LENGTH_M / 1000} km ` +
      `with a destination at an end or ${MIN_DEAD_END_CLIMB_M} m of climb`,
  );

  const corrections: Correction[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  for (;;) {
    const batch = await prisma.trail.findMany({
      where,
      select: {
        id: true,
        slug: true,
        name: true,
        regionName: true,
        lengthM: true,
        surface: true,
        sacScale: true,
        profile: { select: { points: true, highPointIndex: true } },
        // Only the kinds that can decide the question — a gate or a car park cannot.
        waypoints: {
          where: { kind: { in: [...TERMINAL_DESTINATIONS] } },
          select: { kind: true, lng: true, lat: true },
        },
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (batch.length === 0) break;

    for (const trail of batch) {
      const correction = reclassify(trail);
      if (correction) corrections.push(correction);
    }

    scanned += batch.length;
    cursor = batch[batch.length - 1]!.id;
    if (scanned % 1000 === 0 || scanned === total) {
      console.log(`  scanned ${scanned}/${total} · ${corrections.length} to correct`);
    }
  }

  if (corrections.length === 0) {
    console.log('nothing to reclassify');
    return;
  }

  const byRule = {
    terminus: corrections.filter((c) => c.by === 'terminus'),
    climb: corrections.filter((c) => c.by === 'climb'),
    both: corrections.filter((c) => c.by === 'both'),
  };
  console.log(
    `\n${corrections.length} trails are spurs hiked out and back — ` +
      `${byRule.terminus.length} by what is at the end, ${byRule.climb.length} by where the ` +
      `climb stops, ${byRule.both.length} by both.`,
  );

  // Sampled per rule rather than off the top of the list, because the two rules fail in
  // different ways and a combined sample sorted by id would show mostly whichever fired more.
  for (const [rule, group] of Object.entries(byRule)) {
    if (group.length === 0) continue;
    console.log(`\n  — ${rule} —`);
    for (const c of group.slice(0, SAMPLE)) {
      const region = c.regionName ? ` · ${c.regionName}` : '';
      console.log(
        `  ${c.name}${region}\n` +
          `    ${(c.fromLengthM / 1000).toFixed(1)} km one way → ${(c.toLengthM / 1000).toFixed(1)} km round trip  (/trails/${c.slug})`,
      );
    }
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write these ${corrections.length} rows.`);
    return;
  }

  /**
   * One statement per trail, because every row gets different numbers — there is no
   * `updateMany` shape that expresses "each of these gets its own seven statistics".
   * Chunked into transactions so a failure halfway leaves a consistent prefix rather than
   * a catalogue half-corrected in a way nothing records.
   */
  let written = 0;
  for (let i = 0; i < corrections.length; i += BATCH) {
    const chunk = corrections.slice(i, i + BATCH);
    await prisma.$transaction(
      chunk.map((c) => prisma.trail.update({ where: { id: c.id }, data: c.update })),
    );
    written += chunk.length;
    console.log(`  wrote ${written}/${corrections.length}`);
  }
  console.log(`\nreclassified ${written}`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
