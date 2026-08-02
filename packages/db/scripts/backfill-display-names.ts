/**
 * Backfill `trails.displayName`, and the search vector that carries it, for trails ingested
 * before it existed. Dry run by default: nothing is written without `--apply`, and writing
 * anywhere but a local database needs a second flag.
 */
import { readFileSync } from 'node:fs';
import { describeDisplayName, refuseDisplayName, SUMMIT_TOP_TOLERANCE_M } from '@switchback/core';
import type {
  DestinationCandidate,
  DisplayName,
  DisplayNameInput,
  DisplayNameRefusal,
  DisplayNameRule,
} from '@switchback/core';
import { Prisma, prisma, refreshTrailSearchVector } from '@switchback/db';
import { flagValue } from './flags';
import { isLocalDatabase } from './local-database';
import { osmKey } from './peak-elevations';
import type { OsmType } from './peak-elevations';

/** Trails per page. Each carries its waypoints, so a larger page is a much larger response. */
const PAGE_SIZE = 500;

/** How many examples to print, so a dry run reads as evidence rather than a dump. */
const SAMPLE_LIMIT = 20;

interface Options {
  apply: boolean;
  allowRemote: boolean;
  /** `backfill-peak-elevations --out`: heights fetched but not yet written. Dry run only. */
  peaks: string | null;
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
  if (isLocalDatabase(url)) return;

  const redacted = url.replace(/:[^:@]*@/, ':***@');
  if (!options.allowRemote) {
    throw new Error(
      `refusing to write to a database that is not local (${redacted}).\n` +
        'This may be production: 24,671 real trails. Re-run with --apply --yes-production only ' +
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
  /** Every trail's first refusal, named — the other half of a coverage number. */
  byRefusal: Partial<Record<DisplayNameRefusal, number>>;
}

/**
 * What the titles become once the fetched peak heights are written, held beside what they are
 * now. The two backfills have to be read in this order — heights first, then names — and this
 * is how that is shown rather than asserted.
 */
interface Projection {
  byRule: Record<DisplayNameRule, number>;
  kept: number;
  gained: number;
  lost: number;
  changed: number;
  /** Summit titles naming a peak standing more than the tolerance above anything the trail reaches. */
  overreaching: number;
  /** …of which the fetched height actually withdraws. */
  withdrawn: number;
  samples: Array<{ delta: number; line: string }>;
}

/** Heights fetched but not yet written, by `osmKey`. Read-only: nothing here reaches the database. */
function loadPeaks(path: string): Map<string, number> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { eleM?: Record<string, number> };
  const entries = Object.entries(parsed.eleM ?? {});
  if (entries.length === 0) throw new Error(`${path} holds no heights — is it an --out file?`);
  return new Map(entries);
}

/** A trail as this script loads it: the naming input, plus what each waypoint points at in OSM. */
type ProjectableInput = Omit<DisplayNameInput, 'waypoints'> & {
  waypoints: ReadonlyArray<
    DestinationCandidate & { osmType: OsmType | null; osmId: bigint | null }
  >;
};

/**
 * What this trail's title becomes once the fetched heights land, tallied against what it is now.
 * `overreaching` is counted from the peak's own height rather than from the refusal that follows
 * it, because a withdrawn summit often falls through to the destination clause — which answers
 * `named` and hides the very titles this exists to find.
 */
function project(
  input: ProjectableInput,
  before: DisplayName | null,
  fetched: ReadonlyMap<string, number>,
  into: Projection,
): void {
  const waypoints = input.waypoints.map((w) => {
    const key = w.osmType !== null && w.osmId !== null ? osmKey(w.osmType, w.osmId) : null;
    return { ...w, osmEleM: (key === null ? undefined : fetched.get(key)) ?? w.osmEleM ?? null };
  });
  const after = describeDisplayName({ ...input, waypoints });

  const beforeName = before?.displayName ?? null;
  const afterName = after?.displayName ?? null;
  if (after) into.byRule[after.rule]++;

  if (beforeName === null && afterName !== null) into.gained++;
  else if (beforeName !== null && afterName === null) into.lost++;
  else if (beforeName !== null && afterName === beforeName) into.kept++;
  else if (beforeName !== null) into.changed++;

  if (before === null || before.rule !== 'summit') return;
  const peak = waypoints.find((w) => w.kind === 'summit' && w.name === before.destination);
  const height = peak?.osmEleM;
  if (height === null || height === undefined) return;

  const delta = height - input.maxEleM;
  if (delta <= SUMMIT_TOP_TOLERANCE_M) return;
  into.overreaching++;
  if (afterName !== beforeName) into.withdrawn++;
  into.samples.push({
    delta,
    line: `+${Math.round(delta)} m  ${beforeName} → ${afterName ?? '(no title)'}`,
  });
}

/**
 * Whether the column is there yet. The dry run has to answer this rather than assume: its whole
 * point is to be read before the schema ships, and selecting `displayName` on a database that
 * has not had it pushed fails the query outright — which is precisely the run you want to work.
 */
async function columnExists(column: string, table = 'trails'): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ one: number }>>(
    Prisma.sql`select 1 as one from information_schema.columns
                where table_name = ${table} and column_name = ${column}`,
  );
  return rows.length > 0;
}

/**
 * How many summits carry a peak height. Summits and not every waypoint: ingest writes `osmEleM`
 * on anything tagged `ele`, so a viewpoint or a ford re-ingested since the column shipped would
 * answer this question with a number that verifies no summit title at all.
 */
async function countPeakElevations(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>(
    Prisma.sql`select count(*) as n from waypoints
                where "osmEleM" is not null and kind = 'summit'::"WaypointKind"`,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Along-line length of each stored geometry, in metres — the domain `waypoints.distM` is
 * measured in, and not what `lengthM` holds: that is the *published* figure, doubled for a
 * mirrored out-and-back and more than 2% adrift on 763 trails besides. A row whose `geom`
 * write failed is simply absent, and the naming rules refuse on a line they cannot measure.
 */
async function storedLineLengths(ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ id: string; m: number }>>(
    Prisma.sql`select id, ST_Length("geom"::geography) as m
                 from trails
                where id in (${Prisma.join([...ids])}) and "geom" is not null`,
  );
  return new Map(rows.map((row) => [row.id, Number(row.m)]));
}

/**
 * Each waypoint's `osmEleM`, by waypoint id. Raw SQL rather than a `select`, because the
 * column may not exist yet and Prisma rejects an unknown field even when it is asked for
 * conditionally — and a dry run that only works after the schema ships is no use at all.
 */
async function peakElevations(trailIds: readonly string[]): Promise<Map<string, number>> {
  if (trailIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ id: string; m: number }>>(
    Prisma.sql`select id, "osmEleM" as m
                 from waypoints
                where "trailId" in (${Prisma.join([...trailIds])}) and "osmEleM" is not null`,
  );
  return new Map(rows.map((row) => [row.id, Number(row.m)]));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options: Options = {
    apply: argv.includes('--apply'),
    allowRemote: argv.includes('--yes-production'),
    peaks: flagValue(argv, '--peaks'),
  };
  assertWriteAllowed(options);
  if (options.apply && options.peaks) {
    throw new Error(
      '--peaks projects titles from heights that are not in the database. Run ' +
        '`backfill-peak-elevations --apply` first, then apply names from what it wrote.',
    );
  }
  const fetchedPeaks = options.peaks ? loadPeaks(options.peaks) : null;

  const hasColumn = await columnExists('displayName');
  if (options.apply && !hasColumn) {
    throw new Error(
      'trails.displayName does not exist yet. Ship the schema first — CI runs `prisma db push` ' +
        'on a master push — then re-run this.',
    );
  }
  if (!hasColumn) {
    console.log('trails.displayName is not in this database yet; reporting what it would hold.\n');
  }
  // The summit clause falls back to its weaker on-trail test wherever a waypoint has no peak
  // height. Ask whether any row *holds* one, not whether the column exists: `prisma db push` on a
  // master push creates it empty, and a check on existence alone goes quiet at exactly the moment
  // the data is still entirely absent — which is the moment somebody runs `--apply`.
  const hasPeakEle = await columnExists('osmEleM', 'waypoints');
  const peakEleRows = hasPeakEle ? await countPeakElevations() : 0;
  if (peakEleRows === 0) {
    console.log(
      hasPeakEle
        ? 'waypoints.osmEleM exists but no row holds a peak height yet; summit titles are UNVERIFIED.\n' +
            'Re-ingest before --apply, or the summit clause names peaks the trail never reaches.\n'
        : 'waypoints.osmEleM is not in this database yet; summit titles are UNVERIFIED.\n',
    );
  } else {
    console.log(`waypoints.osmEleM populated on ${peakEleRows} rows; summit titles verified.\n`);
  }

  const tally: Tally = {
    scanned: 0,
    named: 0,
    cleared: 0,
    unchanged: 0,
    byRule: { summit: 0, destination: 0 },
    byRefusal: {},
  };
  const projection: Projection = {
    byRule: { summit: 0, destination: 0 },
    kept: 0,
    gained: 0,
    lost: 0,
    changed: 0,
    overreaching: 0,
    withdrawn: 0,
    samples: [],
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
        minEleM: true,
        maxEleM: true,
        waypoints: {
          select: {
            id: true,
            kind: true,
            name: true,
            distM: true,
            eleM: true,
            osmType: true,
            osmId: true,
          },
        },
      },
    });
    if (trails.length === 0) break;
    cursor = trails[trails.length - 1]!.id;

    const ids = trails.map((trail) => trail.id);
    const lineLengths = await storedLineLengths(ids);
    const peaks = hasPeakEle ? await peakElevations(ids) : new Map<string, number>();

    for (const trail of trails) {
      tally.scanned++;
      // Zero for a row whose `geom` write failed: `atFarEnd` refuses on a line it cannot
      // measure rather than falling back to `lengthM`, which is the bug this replaced.
      const input = {
        ...trail,
        lineLengthM: lineLengths.get(trail.id) ?? 0,
        waypoints: trail.waypoints.map((w) => ({ ...w, osmEleM: peaks.get(w.id) ?? null })),
      };
      const derived = describeDisplayName(input);
      const next = derived?.displayName ?? null;
      const current = hasColumn ? trail.displayName : null;

      if (derived === null) {
        const reason = refuseDisplayName(input);
        tally.byRefusal[reason] = (tally.byRefusal[reason] ?? 0) + 1;
      }

      if (fetchedPeaks) project(input, derived, fetchedPeaks, projection);

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
        // The vector too, in the same breath. `displayName` is weighted into it, and a name
        // nobody can search for is half a feature — ingest rebuilds both together for the same
        // reason. Two statements rather than one because the vector is raw SQL over a column
        // Prisma cannot type.
        await prisma.trail.update({ where: { id: trail.id }, data: { displayName: next } });
        await refreshTrailSearchVector(prisma, trail.id);
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

  console.log('\nrefused, by first reason:');
  for (const [reason, count] of Object.entries(tally.byRefusal).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(26)} ${count}`);
  }

  // Spread across the run rather than the first twenty, which would all come from one region.
  if (samples.length > 0) {
    console.log('\nsamples:');
    const step = Math.max(1, Math.floor(samples.length / SAMPLE_LIMIT));
    for (let i = 0; i < samples.length && i / step < SAMPLE_LIMIT; i += step) {
      console.log(`  ${samples[i]}`);
    }
  }
  if (fetchedPeaks) {
    const total = projection.byRule.summit + projection.byRule.destination;
    console.log(`\nprojected from ${fetchedPeaks.size} fetched heights, still unwritten:`);
    console.log(`  titles     ${total}`);
    console.log(`    summit       ${projection.byRule.summit}`);
    console.log(`    destination  ${projection.byRule.destination}`);
    console.log(`  unchanged  ${projection.kept}`);
    console.log(`  gained     ${projection.gained}`);
    console.log(`  lost       ${projection.lost}`);
    console.log(`  changed    ${projection.changed}`);
    console.log(
      `\n${projection.overreaching} of today's titles name a peak more than ` +
        `${SUMMIT_TOP_TOLERANCE_M} m above anything their trail reaches; ` +
        `${projection.withdrawn} change once the heights land.`,
    );
    if (projection.samples.length > 0) {
      console.log('\nwithdrawn or replaced, worst overreach first:');
      for (const sample of [...projection.samples]
        .sort((a, b) => b.delta - a.delta)
        .slice(0, SAMPLE_LIMIT)) {
        console.log(`  ${sample.line}`);
      }
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
