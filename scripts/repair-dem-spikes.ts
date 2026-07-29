/**
 * Re-derive stored elevation profiles through the spike filter, and correct the statistics
 * that were computed from the holes.
 *
 * `despike` is new. Every profile ingested before it went in was written straight from the
 * terrain tiles, so a tile that reads sea floor where it should read beach is still sitting in
 * the corpus — and `computeGainLoss` faithfully counts the descent into the hole and the climb
 * back out. Kalaloch Beaches, a flat walk along the Washington coast, publishes kilometres of
 * ascent it does not have.
 *
 * Nothing about those rows changes on its own, because nothing re-reads a profile once it is
 * stored. This runs the filter over the samples already in the database — no Overpass, no
 * terrain tiles, no network at all, because every elevation it needs is in the profile — and
 * rewrites the eight statistics derived from elevation.
 *
 *   npx dotenv -e .env -- npx tsx scripts/repair-dem-spikes.ts            # report only
 *   npx dotenv -e .env -- npx tsx scripts/repair-dem-spikes.ts --apply    # write it
 *
 * `despike` and `fillGaps` are run over the stored samples directly rather than through
 * `buildProfile`, and the difference is not a shortcut. `buildProfile` resamples distance from
 * the coordinates and rounds every reading to a tenth; the corpus predates that rounding, so
 * putting stored profiles back through it moves 38,651 of them by up to 5 cm a sample and
 * drifts the length of the longest by tens of metres. Running the two filters alone changes
 * exactly the samples the filter rejects and leaves every other number bit-identical.
 *
 * `lengthM` is never written, for the same reason: despiking touches elevation and nothing
 * else, so a length that moved would mean this script had misread the geometry rather than
 * repaired it. The run reports any such trail and refuses to write it.
 *
 * Mirroring is rediscovered the way every reader has to rediscover it — `hikedProfile`
 * compares the stored geometry against `lengthM`, because the row does not record whether
 * ingest doubled the profile before measuring it. See the note on `derive.ts`.
 */
import type { ElevationPoint } from '@switchback/core';
import { classifyDifficulty } from '@switchback/core';
import { type Difficulty, prisma } from '@switchback/db';
import {
  computeTrailStats,
  despike,
  fillGaps,
  hikedProfile,
  highPointIndex,
  terrainFactorFor,
} from '@switchback/geo';

/** How many trails to hold in memory at once. Each carries a profile of up to ~6,000 samples. */
const BATCH = 200;

/** How many repairs to print, so the operator can spot-check before applying. */
const SAMPLE = Number(process.env.SAMPLE ?? 15);

interface Repair {
  id: string;
  slug: string;
  name: string;
  /** Samples the filter rejected. One trail can hold a dozen. */
  dropped: number;
  /** The worst of them, for the report — a hole this deep is what the reader would have seen. */
  deepestM: number;
  fromGainM: number;
  fromLossM: number;
  fromMinEleM: number;
  lengthDriftM: number;
  points: ElevationPoint[];
  highPointIndex: number;
  update: {
    gainM: number;
    lossM: number;
    minEleM: number;
    maxEleM: number;
    maxSustainedGrade: number | null;
    estimatedTimeS: number;
    difficulty: Difficulty;
    difficultyScore: number;
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const repairs: Repair[] = [];
  const refused: string[] = [];
  let read = 0;
  let cursor: string | undefined;

  for (;;) {
    const batch = await prisma.trail.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      where: { profile: { isNot: null } },
      select: {
        id: true,
        slug: true,
        name: true,
        lengthM: true,
        gainM: true,
        lossM: true,
        minEleM: true,
        routeType: true,
        surface: true,
        sacScale: true,
        profile: { select: { points: true } },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;
    read += batch.length;

    for (const trail of batch) {
      const points = trail.profile?.points as ElevationPoint[] | undefined;
      if (!points || points.length < 3) continue;

      const coords = points.map((p) => p.distM);
      const rejected = despike(
        points.map((p) => p.eleM),
        coords,
      );
      const filled = fillGaps(rejected);

      let dropped = 0;
      let deepestM = 0;
      for (let i = 0; i < points.length; i++) {
        if (rejected[i] !== null) continue;
        dropped++;
        const delta = points[i]!.eleM - filled[i]!;
        if (Math.abs(delta) > Math.abs(deepestM)) deepestM = delta;
      }
      if (dropped === 0) continue;

      const rebuilt: ElevationPoint[] = points.map((p, i) => ({ ...p, eleM: filled[i]! }));

      const hiked = hikedProfile(rebuilt, {
        routeType: trail.routeType,
        lengthM: trail.lengthM,
      });
      const stats = computeTrailStats(hiked, {
        terrainFactor: terrainFactorFor({
          sacScale: trail.sacScale,
          surface: trail.surface,
        }),
      });

      const lengthDriftM = stats.lengthM - trail.lengthM;
      if (Math.abs(lengthDriftM) > 1) {
        refused.push(`${trail.name} (${trail.slug}): length moved ${lengthDriftM} m`);
        continue;
      }

      const classified = classifyDifficulty({
        gainM: stats.gainM,
        lengthM: trail.lengthM,
        sacScale: trail.sacScale ?? undefined,
        maxSustainedGrade: stats.maxSustainedGrade ?? undefined,
      });

      repairs.push({
        id: trail.id,
        slug: trail.slug,
        name: trail.name,
        dropped,
        deepestM,
        fromGainM: trail.gainM,
        fromLossM: trail.lossM,
        fromMinEleM: trail.minEleM,
        lengthDriftM,
        points: rebuilt,
        highPointIndex: highPointIndex(rebuilt),
        update: {
          gainM: stats.gainM,
          lossM: stats.lossM,
          minEleM: stats.minEleM,
          maxEleM: stats.maxEleM,
          maxSustainedGrade: stats.maxSustainedGrade,
          estimatedTimeS: stats.estimatedTimeS,
          difficulty: classified.difficulty,
          difficultyScore: classified.score,
        },
      });
    }
  }

  const samples = repairs.reduce((n, r) => n + r.dropped, 0);
  const phantomM = repairs.reduce((n, r) => n + (r.fromGainM - r.update.gainM), 0);
  console.log(
    `read ${read} trails with a profile\n` +
      `${repairs.length} carry a spike — ${samples} samples in total\n` +
      `${phantomM.toLocaleString()} m of ascent published that is not there`,
  );
  for (const r of refused) console.log(`  refused — ${r}`);

  if (repairs.length === 0) return;

  console.log('\n  — deepest holes —');
  for (const r of [...repairs].sort((a, b) => a.deepestM - b.deepestM).slice(0, SAMPLE)) {
    console.log(
      `  ${r.name}\n` +
        `    ${r.dropped} sample${r.dropped === 1 ? '' : 's'}, worst ${Math.round(r.deepestM)} m off · ` +
        `gain ${r.fromGainM} → ${r.update.gainM} m · low point ${r.fromMinEleM} → ` +
        `${r.update.minEleM} m  (/trails/${r.slug})`,
    );
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write these ${repairs.length} rows.`);
    return;
  }

  let written = 0;
  for (const r of repairs) {
    await prisma.$transaction([
      prisma.elevationProfile.update({
        where: { trailId: r.id },
        data: { points: r.points, highPointIndex: r.highPointIndex },
      }),
      prisma.trail.update({ where: { id: r.id }, data: r.update }),
    ]);
    written++;
    console.log(`  wrote ${written}/${repairs.length}  ${r.slug}`);
  }
  console.log(`\nrepaired ${written}`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
