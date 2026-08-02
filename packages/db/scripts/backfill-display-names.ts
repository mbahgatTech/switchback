/**
 * Backfill `trails.displayName` for trails ingested before it existed. Dry run by default:
 * nothing is written without `--apply`, and writing to a hosted database needs a second flag.
 */
import { describeDisplayName } from '@switchback/core';
import type { DisplayNameRule } from '@switchback/core';
import { Prisma, prisma } from '@switchback/db';

/** Trails per page. Each carries its waypoints, so a larger page is a much larger response. */
const PAGE_SIZE = 500;

/** How many examples to print, so a dry run reads as evidence rather than a dump. */
const SAMPLE_LIMIT = 20;

const HOSTED_DATABASE = /neon\.tech|amazonaws\.com|supabase\.co|postgres\.database\.azure\.com/;

interface Options {
  apply: boolean;
  allowHosted: boolean;
}

/**
 * The production guard, deliberately weaker than `seed.ts`'s. A seed has no business running
 * against production and refuses outright; a backfill's whole purpose is to reach it eventually,
 * so this asks for the intent to be stated instead of pretending it never happens. Both flags
 * are needed together, and the dry run — which writes nothing — runs anywhere.
 */
function assertWriteAllowed(options: Options): void {
  if (!options.apply) return;
  const url = process.env.DATABASE_URL ?? '';
  if (!HOSTED_DATABASE.test(url)) return;

  const redacted = url.replace(/:[^:@]*@/, ':***@');
  if (!options.allowHosted) {
    throw new Error(
      `refusing to write to a hosted database (${redacted}).\n` +
        'This is production: 24,671 real trails. Re-run with --apply --yes-production only ' +
        'after reading the dry run, and expect to answer for the names it printed.',
    );
  }
  console.warn(`\n!!! WRITING displayName TO ${redacted} !!!\n`);
}

interface Tally {
  scanned: number;
  named: number;
  cleared: number;
  unchanged: number;
  byRule: Record<DisplayNameRule, number>;
}

/**
 * Whether the column is there yet. The dry run has to answer this rather than assume: its whole
 * point is to be read before the schema ships, and selecting `displayName` on a database that
 * has not had it pushed fails the query outright — which is precisely the run you want to work.
 */
async function columnExists(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ one: number }>>(
    Prisma.sql`select 1 as one from information_schema.columns
                where table_name = 'trails' and column_name = 'displayName'`,
  );
  return rows.length > 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options: Options = {
    apply: argv.includes('--apply'),
    allowHosted: argv.includes('--yes-production'),
  };
  assertWriteAllowed(options);

  const hasColumn = await columnExists();
  if (options.apply && !hasColumn) {
    throw new Error(
      'trails.displayName does not exist yet. Ship the schema first — CI runs `prisma db push` ' +
        'on a master push — then re-run this.',
    );
  }
  if (!hasColumn) {
    console.log('trails.displayName is not in this database yet; reporting what it would hold.\n');
  }

  const tally: Tally = {
    scanned: 0,
    named: 0,
    cleared: 0,
    unchanged: 0,
    byRule: { summit: 0, destination: 0 },
  };
  const samples: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const trails = await prisma.trail.findMany({
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        displayName: hasColumn,
        routeType: true,
        lengthM: true,
        gainM: true,
        maxEleM: true,
        waypoints: { select: { kind: true, name: true, distM: true, eleM: true } },
      },
    });
    if (trails.length === 0) break;
    cursor = trails[trails.length - 1]!.id;

    for (const trail of trails) {
      tally.scanned++;
      const derived = describeDisplayName(trail);
      const next = derived?.displayName ?? null;
      const current = hasColumn ? trail.displayName : null;

      if (next === current) {
        tally.unchanged++;
        continue;
      }
      if (derived === null) {
        tally.cleared++;
      } else {
        tally.named++;
        tally.byRule[derived.rule]++;
        samples.push(`${derived.rule.padEnd(11)} ${derived.displayName}`);
      }

      if (options.apply) {
        await prisma.trail.update({ where: { id: trail.id }, data: { displayName: next } });
      }
    }

    console.log(`scanned ${tally.scanned}…`);
  }

  console.log(`\n${options.apply ? 'applied' : 'dry run — nothing written'}`);
  console.log(`  scanned    ${tally.scanned}`);
  console.log(`  named      ${tally.named}`);
  console.log(`    summit       ${tally.byRule.summit}`);
  console.log(`    destination  ${tally.byRule.destination}`);
  console.log(`  cleared    ${tally.cleared}`);
  console.log(`  unchanged  ${tally.unchanged}`);

  // Spread across the run rather than the first twenty, which would all come from one region.
  if (samples.length > 0) {
    console.log('\nsamples:');
    const step = Math.max(1, Math.floor(samples.length / SAMPLE_LIMIT));
    for (let i = 0; i < samples.length && i / step < SAMPLE_LIMIT; i += step) {
      console.log(`  ${samples[i]}`);
    }
  }
  if (!options.apply) {
    console.log('\nRe-run with --apply to write. Against production, add --yes-production.');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
