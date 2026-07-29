/**
 * Re-measure the steepest sustained grade over trails already in the database.
 *
 * `maxSustainedGrade` slid its window's tail forward to keep the run under 100 m, which on
 * any profile whose resampled step lands a hair *over* 25 m left a run of 75.6 m — below its
 * own tolerance, so the reading was skipped, and since the tail never moves back, every later
 * reading was skipped too. The function returned its initial 0. Profiles spaced a hair
 * *under* 25 m never tripped it, and that coin flip is the whole population split: of 55,842
 * stored profiles, 13,163 hold a literal 0, and 1,433 of those climb more than 200 m — the
 * Mist Trail among them, reporting a steepest grade of 0% under a stat block saying it gains
 * 748 m.
 *
 * Nothing about those rows changes when the measurement is fixed, so they will never learn
 * about it on their own. This re-runs it over the stored profile — no Overpass, no terrain
 * tiles, no network at all — and reclassifies difficulty with the answer, because grade sets
 * a floor there (25% is at least moderate, 35% at least hard) and a trail measured at 0 was
 * classified with that floor silently absent.
 *
 *   npx tsx scripts/backfill-sustained-grade.ts            # report only, changes nothing
 *   npx tsx scripts/backfill-sustained-grade.ts --apply    # write the corrections
 *
 * Dry run is the default, and the report to read before applying is the count of trails
 * still reading 0% under real climb: that is the defect, and it should come out at zero.
 *
 * Length, gain and loss are deliberately left alone. They are computed over the *mirrored*
 * profile for a trail with an implied return leg, and this script cannot tell from a row
 * whether that happened — but the grade is unaffected by mirroring, because a retraced leg
 * repeats the same pitches it just climbed.
 */
import type { ElevationPoint } from '@switchback/core';
import { classifyDifficulty } from '@switchback/core';
import { type Difficulty, prisma } from '@switchback/db';
import { maxSustainedGrade } from '@switchback/geo';

/** How many trails to hold in memory at once. Each carries a profile of up to ~6,000 samples. */
const BATCH = 200;

/** How many corrections to print, so the operator can spot-check before applying. */
const SAMPLE = Number(process.env.SAMPLE ?? 15);

/** Below this the reading moved, but not by enough for anyone to have read it differently. */
const NOISE = 0.005;

interface Correction {
  id: string;
  slug: string;
  name: string;
  gainM: number;
  from: number | null;
  to: number | null;
  fromDifficulty: Difficulty;
  toDifficulty: Difficulty;
  /** A grade of 0 under real climb is the failure this script exists for; the rest is drift. */
  wasZero: boolean;
  update: { maxSustainedGrade: number | null; difficulty: Difficulty; difficultyScore: number };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const corrections: Correction[] = [];
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
        sacScale: true,
        difficulty: true,
        maxSustainedGrade: true,
        profile: { select: { points: true } },
      },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;
    read += batch.length;

    for (const trail of batch) {
      const points = trail.profile?.points as ElevationPoint[] | undefined;
      if (!points || points.length < 2) continue;

      const grade = maxSustainedGrade(points);
      const before = trail.maxSustainedGrade;
      if (grade === before) continue;
      if (grade !== null && before !== null && Math.abs(grade - before) < NOISE) continue;

      const classified = classifyDifficulty({
        gainM: trail.gainM,
        lengthM: trail.lengthM,
        sacScale: trail.sacScale ?? undefined,
        maxSustainedGrade: grade ?? undefined,
      });

      corrections.push({
        id: trail.id,
        slug: trail.slug,
        name: trail.name,
        gainM: trail.gainM,
        from: before,
        to: grade,
        fromDifficulty: trail.difficulty,
        toDifficulty: classified.difficulty,
        wasZero: before === 0 && trail.gainM > 200,
        update: {
          maxSustainedGrade: grade,
          difficulty: classified.difficulty,
          difficultyScore: classified.score,
        },
      });
    }
  }

  const zeros = corrections.filter((c) => c.wasZero);
  const reband = corrections.filter((c) => c.fromDifficulty !== c.toDifficulty);
  console.log(
    `read ${read} trails with a profile\n` +
      `${corrections.length} grades move, of which ${zeros.length} were reading 0% on a ` +
      `trail that climbs more than 200 m\n` +
      `${reband.length} change difficulty band`,
  );

  if (corrections.length === 0) return;

  const pct = (g: number | null) => (g === null ? '—' : `${Math.round(g * 100)}%`);
  console.log('\n  — steepest climbs that were reading 0% —');
  for (const c of [...zeros].sort((a, b) => (b.to ?? 0) - (a.to ?? 0)).slice(0, SAMPLE)) {
    const band =
      c.fromDifficulty === c.toDifficulty ? '' : ` · ${c.fromDifficulty} → ${c.toDifficulty}`;
    console.log(
      `  ${c.name}\n    ${pct(c.from)} → ${pct(c.to)} over ${c.gainM} m of climb${band}  (/trails/${c.slug})`,
    );
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write these ${corrections.length} rows.`);
    return;
  }

  let written = 0;
  for (let i = 0; i < corrections.length; i += BATCH) {
    const chunk = corrections.slice(i, i + BATCH);
    await prisma.$transaction(
      chunk.map((c) => prisma.trail.update({ where: { id: c.id }, data: c.update })),
    );
    written += chunk.length;
    console.log(`  wrote ${written}/${corrections.length}`);
  }
  console.log(`\nre-measured ${written}`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
