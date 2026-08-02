/**
 * Backfill `waypoints.osmEleM` from OSM by id — the surveyed height of the feature a trail may
 * be named for. Dry run by default; writing anywhere but a local database needs a second flag.
 */
import { writeFileSync } from 'node:fs';
import { DESTINATION_KINDS, SUMMIT_TOP_TOLERANCE_M } from '@switchback/core';
import type { WaypointKind } from '@switchback/core';
import { Prisma, prisma } from '@switchback/db';
import { getOverpass, parseEleM } from '@switchback/ingest';
import { isLocalDatabase } from './local-database';
import { flagValue } from './flags';
import { osmKey, tagsByIdQuery } from './peak-elevations';
import type { OsmType } from './peak-elevations';

/**
 * The kinds a display name can be built from — `summit`, plus the features `DESTINATION_KINDS`
 * names a walk for. Deliberately narrower than "everything ingest writes `osmEleM` on": a
 * gate's height is accurate and useless, and the 125,581 car parks would be nine tenths of the
 * fetch. Only the summit clause reads this today; the rest are here so that a tolerance test on
 * a pass or a glacier has data the day somebody writes one, rather than a month of re-ingest later.
 */
const PEAK_KINDS: readonly WaypointKind[] = ['summit', ...DESTINATION_KINDS];

/**
 * Ids per Overpass query. `out tags` by id is cheap on the server — no bounding box, no
 * geometry — so the bound that matters is the response, and a few hundred peaks answer in tens
 * of kilobytes well inside the query's own timeout. Thousands would be one timeout away from
 * having to ask for all of them again.
 */
const BATCH_SIZE = 250;

/** Waypoints per page of the candidate scan. Narrow rows, so a page can be a large one. */
const PAGE_SIZE = 2_000;

/** How many examples to print, so a dry run reads as evidence rather than a dump. */
const SAMPLE_LIMIT = 15;

interface Options {
  apply: boolean;
  allowRemote: boolean;
  /** Where to dump what was fetched, for `backfill-display-names --peaks`. Never the database. */
  out: string | null;
  /** Stop after this many distinct ids — a smoke test that does not spend the whole fetch. */
  limit: number;
}

/**
 * The production guard, copied from `backfill-display-names.ts` deliberately rather than shared:
 * both flags together, and the dry run — which writes nothing — runs anywhere.
 */
function assertWriteAllowed(options: Options): void {
  if (!options.apply) return;
  const url = process.env.DATABASE_URL ?? '';
  if (isLocalDatabase(url)) return;

  const redacted = url.replace(/:[^:@]*@/, ':***@');
  if (!options.allowRemote) {
    throw new Error(
      `refusing to write to a database that is not local (${redacted}).\n` +
        'This may be production. Re-run with --apply --yes-production only after reading the ' +
        'dry run, and expect to answer for the heights it printed.',
    );
  }
  console.warn(`\n!!! WRITING osmEleM TO ${redacted} !!!\n`);
}

async function columnExists(column: string, table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ one: number }>>(
    Prisma.sql`select 1 as one from information_schema.columns
                where table_name = ${table} and column_name = ${column}`,
  );
  return rows.length > 0;
}

/** One waypoint that could carry a height, with the trail figure the naming rule compares it to. */
interface Candidate {
  id: string;
  kind: WaypointKind;
  name: string | null;
  osmType: OsmType;
  osmId: bigint;
  trailName: string;
  trailMaxEleM: number;
}

/**
 * Every waypoint of a nameable kind that has an OSM id and no height yet. The `osmEleM is null`
 * clause is what makes the script re-runnable: a row written by a previous run is not selected
 * again, so a second run has only the ones OSM had nothing to say about left to ask about.
 */
async function loadCandidates(): Promise<{ candidates: Candidate[]; withoutType: number }> {
  const candidates: Candidate[] = [];
  let withoutType = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.waypoint.findMany({
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      where: { kind: { in: [...PEAK_KINDS] }, osmId: { not: null }, osmEleM: null },
      select: {
        id: true,
        kind: true,
        name: true,
        osmType: true,
        osmId: true,
        trail: { select: { name: true, maxEleM: true } },
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      // The `where` already excludes a null id; a type can still be missing, and an id without
      // one is unaskable, since node 1 and way 1 are different features.
      if (row.osmId === null || row.osmType === null) {
        withoutType++;
        continue;
      }
      candidates.push({
        id: row.id,
        kind: row.kind,
        name: row.name,
        osmType: row.osmType,
        osmId: row.osmId,
        trailName: row.trail.name,
        trailMaxEleM: row.trail.maxEleM,
      });
    }
  }
  return { candidates, withoutType };
}

interface Fetched {
  /** Height in metres, by `osmKey`. Only ids whose `ele` parsed appear. */
  heights: Map<string, number>;
  /** Ids Overpass answered with an element at all — an absent one has been deleted since ingest. */
  returned: Set<string>;
  /** Ids that carried an `ele` we refused: feet, a range, prose. `parseEleM` decides, not us. */
  refused: string[];
}

/**
 * Ask Overpass for each id's tags, in batches, through the shared client — which is what
 * enforces two concurrent requests, the backoff, the mirror rotation and the breaker. A batch
 * that still fails after all of that aborts the run rather than being skipped: the run is
 * re-runnable by construction, and a quietly short answer would report coverage we do not have.
 */
async function fetchHeights(keyed: ReadonlyMap<string, Candidate[]>): Promise<Fetched> {
  const overpass = getOverpass();
  const heights = new Map<string, number>();
  const returned = new Set<string>();
  const refused: string[] = [];

  const byType = new Map<OsmType, bigint[]>();
  for (const rows of keyed.values()) {
    const first = rows[0]!;
    const ids = byType.get(first.osmType) ?? [];
    ids.push(first.osmId);
    byType.set(first.osmType, ids);
  }

  let done = 0;
  for (const [osmType, ids] of byType) {
    for (let at = 0; at < ids.length; at += BATCH_SIZE) {
      const batch = ids.slice(at, at + BATCH_SIZE);
      const body = await overpass.query(tagsByIdQuery(osmType, batch));

      for (const element of body.elements) {
        if (element.type !== osmType) continue;
        const key = osmKey(osmType, element.id);
        returned.add(key);
        const raw = element.tags?.ele;
        if (raw === undefined) continue;
        const metres = parseEleM(raw);
        if (metres === null) refused.push(`${key} ele="${raw.slice(0, 40)}"`);
        else heights.set(key, metres);
      }

      done += batch.length;
      console.log(`asked ${done}/${keyed.size} ids…`);
    }
  }
  return { heights, returned, refused };
}

/** The 5 largest, the 3 smallest, and a spread between them — extremes plus a shape. */
function chooseSamples<T>(sorted: readonly T[]): T[] {
  if (sorted.length <= SAMPLE_LIMIT) return [...sorted];
  const picked = new Set<number>();
  for (let i = 0; i < 5; i++) picked.add(i);
  for (let i = 1; i <= 3; i++) picked.add(sorted.length - i);
  const step = Math.max(1, Math.floor(sorted.length / SAMPLE_LIMIT));
  for (let i = 5; i < sorted.length && picked.size < SAMPLE_LIMIT; i += step) picked.add(i);
  return [...picked].sort((a, b) => a - b).map((index) => sorted[index]!);
}

/** Bucket edges for `osmEleM - trail.maxEleM`, straddling the naming rule's own tolerance. */
const DELTA_EDGES = [-100, -30, 0, SUMMIT_TOP_TOLERANCE_M, 50, 100] as const;

function bucketLabels(): string[] {
  const labels = [`below ${DELTA_EDGES[0]} m`];
  for (let i = 1; i < DELTA_EDGES.length; i++) {
    labels.push(`${DELTA_EDGES[i - 1]} to ${DELTA_EDGES[i]} m`);
  }
  labels.push(`above ${DELTA_EDGES[DELTA_EDGES.length - 1]} m`);
  return labels;
}

function bucketOf(delta: number): number {
  const at = DELTA_EDGES.findIndex((edge) => delta <= edge);
  return at === -1 ? DELTA_EDGES.length : at;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options: Options = {
    apply: argv.includes('--apply'),
    allowRemote: argv.includes('--yes-production'),
    out: flagValue(argv, '--out'),
    limit: Math.max(0, Number(flagValue(argv, '--limit') ?? 0)),
  };
  assertWriteAllowed(options);

  if (!(await columnExists('osmEleM', 'waypoints'))) {
    throw new Error(
      'waypoints.osmEleM does not exist in this database. Ship the schema first — CI runs ' +
        '`prisma db push` on a master push — then re-run this.',
    );
  }

  const { candidates, withoutType } = await loadCandidates();
  // One peak is a waypoint of every trail that passes it, so the number of ids to ask about is
  // well below the number of rows to write. Asking once per row would be the same query three
  // times over, which is precisely the behaviour a public instance blocks a client for.
  const keyed = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = osmKey(candidate.osmType, candidate.osmId);
    const rows = keyed.get(key) ?? [];
    rows.push(candidate);
    keyed.set(key, rows);
  }

  const byKind = new Map<WaypointKind, number>();
  for (const candidate of candidates) {
    byKind.set(candidate.kind, (byKind.get(candidate.kind) ?? 0) + 1);
  }

  console.log(`considering ${candidates.length} waypoints over ${keyed.size} distinct OSM ids`);
  for (const kind of PEAK_KINDS) {
    console.log(`  ${kind.padEnd(11)} ${byKind.get(kind) ?? 0}`);
  }
  if (withoutType > 0) {
    console.log(`  (${withoutType} carry an id with no element type and cannot be asked about)`);
  }
  if (keyed.size === 0) {
    console.log('\nnothing to do.');
    return;
  }

  const asking = options.limit > 0 ? new Map([...keyed].slice(0, options.limit)) : keyed;
  if (asking.size < keyed.size)
    console.log(`--limit ${options.limit}: asking about ${asking.size}`);
  console.log(
    `\n${Math.ceil(asking.size / BATCH_SIZE)} Overpass queries at ${BATCH_SIZE} ids each`,
  );

  const { heights, returned, refused } = await fetchHeights(asking);

  // What would be written, and what it means for the naming rule. The delta is per row, not per
  // id: the same peak stands a different height above each trail that passes it, and that
  // comparison is what `reachesTheTop` makes.
  const writes: Array<{ candidate: Candidate; metres: number; delta: number }> = [];
  for (const [key, rows] of asking) {
    const metres = heights.get(key);
    if (metres === undefined) continue;
    for (const candidate of rows) {
      writes.push({ candidate, metres, delta: metres - candidate.trailMaxEleM });
    }
  }

  if (options.apply) {
    for (const [key, rows] of asking) {
      const metres = heights.get(key);
      if (metres === undefined) continue;
      // Every row this id stands for learns the same height in one statement, and `data`
      // carries `osmEleM` alone — `eleM` is the on-trail profile sample the section chart plots
      // against `distM`, and is not this number.
      await prisma.waypoint.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { osmEleM: metres },
      });
    }
  }

  console.log(`\n${options.apply ? 'applied' : 'dry run — nothing written'}`);
  console.log(`  considered      ${candidates.length} rows / ${keyed.size} ids`);
  console.log(`  asked           ${asking.size} ids`);
  console.log(`  Overpass had    ${returned.size}`);
  console.log(`  carried an ele  ${heights.size + refused.length}`);
  console.log(`    usable          ${heights.size}`);
  console.log(`    refused         ${refused.length}`);
  console.log(`  would write     ${writes.length} rows`);
  console.log(
    `  stay null       ${asking.size - heights.size} ids — untagged or gone from OSM, and asked about again on the next run`,
  );

  // Per kind, because the aggregate is misleading: `ele` is near-universal on a peak and rare on
  // a viewpoint, and the viewpoints outnumber the summits. A low total is that mix, not a fault.
  const writtenByKind = new Map<WaypointKind, number>();
  for (const write of writes) {
    writtenByKind.set(write.candidate.kind, (writtenByKind.get(write.candidate.kind) ?? 0) + 1);
  }
  console.log('\nrows that gain a height, by kind:');
  for (const kind of PEAK_KINDS) {
    const considered = byKind.get(kind) ?? 0;
    if (considered === 0) continue;
    const written = writtenByKind.get(kind) ?? 0;
    const share = Math.round((100 * written) / considered);
    console.log(`  ${kind.padEnd(11)} ${String(written).padStart(5)} / ${considered}  ${share}%`);
  }

  const summits = writes.filter((write) => write.candidate.kind === 'summit');
  console.log(`\nosmEleM - trail.maxEleM, over the ${summits.length} summit rows the rule reads:`);
  const labels = bucketLabels();
  const counts = new Array<number>(labels.length).fill(0);
  for (const write of summits) counts[bucketOf(write.delta)]!++;
  // The bucket ending at the tolerance is the last one the summit clause still accepts.
  const tolerance = DELTA_EDGES.indexOf(SUMMIT_TOP_TOLERANCE_M);
  for (const [at, label] of labels.entries()) {
    const note =
      at === tolerance
        ? '  (within tolerance — named as today)'
        : at > tolerance
          ? '  (refused now)'
          : '';
    console.log(`  ${label.padEnd(18)} ${String(counts[at]).padStart(5)}${note}`);
  }
  const above = summits.filter((write) => write.delta > SUMMIT_TOP_TOLERANCE_M);
  console.log(
    `\n${above.length} of ${summits.length} summit rows name a peak the trail does not reach.`,
  );

  const sorted = [...summits].sort((a, b) => b.delta - a.delta);
  console.log('\nsamples, highest peak above the trail first:');
  for (const { candidate, metres, delta } of chooseSamples(sorted)) {
    const sign = delta >= 0 ? '+' : '';
    console.log(
      `  ${`${sign}${Math.round(delta)} m`.padStart(8)}  ${String(Math.round(metres)).padStart(5)} m  ` +
        `${candidate.name ?? '(unnamed)'} — ${candidate.trailName}`,
    );
  }

  if (refused.length > 0) {
    console.log('\nele tags parseEleM refused:');
    for (const line of refused.slice(0, SAMPLE_LIMIT)) console.log(`  ${line}`);
  }

  if (options.out) {
    // A scratch file, not a column: `backfill-display-names --peaks` reads it to show what the
    // titles become once this backfill lands, without asking Overpass every id a second time.
    writeFileSync(
      options.out,
      JSON.stringify({ fetchedAt: new Date().toISOString(), eleM: Object.fromEntries(heights) }),
    );
    console.log(`\nwrote ${heights.size} heights to ${options.out}`);
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
