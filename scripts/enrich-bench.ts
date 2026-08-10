/**
 * Association numbers from cached fixtures only, index build counted apart from the per-trail
 * queries. Every pass prints `completed=n/n`: a run that processed fewer trails is a fake speedup.
 *
 *   node --expose-gc --import tsx scripts/enrich-bench.ts <quadkey>... [options]
 *
 *     --sample N        every nth trail rather than all of them
 *     --only a,b        candidates to run (baseline, grid, postgis, postgis-bulk, mutants)
 *     --cells a,b       extra grid candidates at these cell sizes in metres
 *     --no-compare      time only; skip the accuracy diff, which costs a baseline pass each
 *     --pg-margin       report the largest disagreement between the JS and PostGIS distances
 *
 * PostGIS candidates need DATABASE_URL pointing at a local PostGIS. They create temporary
 * tables only, so a run leaves the database as it found it.
 */

import { performance } from 'node:perf_hooks';
import {
  baselineCandidate,
  compareCandidate,
  formatReport,
  type Candidate,
  type TrailInput,
} from '../packages/ingest/test/support/association';
import { gridCandidate } from '../packages/ingest/test/support/association-candidates';
import { mutants } from '../packages/ingest/test/support/association-mutants';
import {
  openPostgis,
  type PostgisSession,
} from '../packages/ingest/test/support/association-postgis';
import { loadEnrichFixture } from '../packages/ingest/test/support/enrich-fixture';

const MIB = 1_048_576;
/** The Function App instance ceiling every memory figure below is measured against. */
const INSTANCE_CEILING_MIB = 1_536;

interface Timing {
  buildMs: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  completed: number;
  attachments: number;
  buildHeapMiB: number;
  peakHeapMiB: number;
}

async function time(
  candidate: Candidate,
  fixture: ReturnType<typeof loadEnrichFixture>,
  trails: TrailInput[],
): Promise<Timing> {
  collect();
  const before = process.memoryUsage().heapUsed;

  const buildStart = performance.now();
  const associator = await candidate.build(fixture.features);
  const buildMs = performance.now() - buildStart;

  collect();
  const afterBuild = process.memoryUsage().heapUsed;

  const perTrail: number[] = [];
  let attachments = 0;
  let peak = afterBuild;
  for (const trail of trails) {
    const started = performance.now();
    const result = await associator.associate(trail.coords);
    perTrail.push(performance.now() - started);
    attachments += result.waypoints.length;
    const heap = process.memoryUsage().heapUsed;
    if (heap > peak) peak = heap;
  }

  const sorted = [...perTrail].sort((a, b) => a - b);
  const totalMs = perTrail.reduce((sum, ms) => sum + ms, 0);
  return {
    buildMs,
    totalMs,
    meanMs: totalMs / (perTrail.length || 1),
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    completed: perTrail.length,
    attachments,
    buildHeapMiB: (afterBuild - before) / MIB,
    peakHeapMiB: (peak - before) / MIB,
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

/** Exposed by `node --expose-gc`; without it the heap figures include uncollected garbage. */
function collect(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

interface Options {
  quadkeys: string[];
  sampleSize: number;
  only: string[];
  cells: number[];
  pgMargin: boolean;
  compare: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    quadkeys: [],
    sampleSize: Number.POSITIVE_INFINITY,
    only: ['baseline', 'grid'],
    cells: [],
    pgMargin: false,
    compare: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--sample') options.sampleSize = Number(argv[++i]);
    else if (arg === '--only') options.only = argv[++i]!.split(',');
    else if (arg === '--cells') options.cells = argv[++i]!.split(',').map(Number);
    else if (arg === '--pg-margin') options.pgMargin = true;
    else if (arg === '--no-compare') options.compare = false;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else options.quadkeys.push(arg);
  }
  return options;
}

function localDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url)) {
    throw new Error('a PostGIS candidate needs DATABASE_URL pointing at a local PostGIS');
  }
  return url;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!(globalThis as { gc?: () => void }).gc) {
    console.log('note: run under `node --expose-gc` for heap figures free of uncollected garbage');
  }

  const wantsPostgres = options.pgMargin || options.only.some((name) => name.startsWith('postgis'));
  let postgis: PostgisSession | null = null;
  if (wantsPostgres) postgis = await openPostgis(localDatabaseUrl());

  try {
    for (const quadkey of options.quadkeys) {
      const fixture = loadEnrichFixture(quadkey);
      const trails = sample(fixture.trails, options.sampleSize).map((trail) => ({
        key: `${trail.osmType}/${trail.osmId}`,
        coords: trail.coords,
      }));
      const vertices = trails.reduce((sum, trail) => sum + trail.coords.length, 0);

      console.log(
        `\ntile=${quadkey} features=${fixture.features.length} ` +
          `trails=${trails.length}/${fixture.trails.length} vertices=${vertices} ` +
          `osmBase=${fixture.timestampOsmBase ?? 'unknown'}`,
      );

      if (options.pgMargin) {
        const worst = await postgis!.measureMargin(fixture.features, trails);
        console.log(`  pg margin     worst JS-vs-PostGIS distance gap ${worst.toExponential(3)} m`);
      }

      const candidates = chosen(options, postgis, trails);
      for (const candidate of candidates) {
        const timing = await time(candidate, fixture, trails);
        const projectionS = (timing.meanMs * fixture.trails.length) / 1000;
        console.log(
          `  ${candidate.name}\n` +
            `    index build   ${timing.buildMs.toFixed(1)} ms, heap +${timing.buildHeapMiB.toFixed(1)} MiB ` +
            `(${((timing.buildHeapMiB / INSTANCE_CEILING_MIB) * 100).toFixed(1)}% of the 1.5 GB instance)\n` +
            `    associate     completed=${timing.completed}/${trails.length} ` +
            `attachments=${timing.attachments} total=${(timing.totalMs / 1000).toFixed(2)} s\n` +
            `    per trail     mean ${timing.meanMs.toFixed(3)} ms  p50 ${timing.p50Ms.toFixed(3)} ms  ` +
            `p95 ${timing.p95Ms.toFixed(3)} ms  max ${timing.maxMs.toFixed(3)} ms\n` +
            `    whole tile    ${fixture.trails.length} trails -> ${projectionS.toFixed(1)} s ` +
            `(${(projectionS / 60).toFixed(2)} min) + ${(timing.buildMs / 1000).toFixed(2)} s build\n` +
            `    peak heap     +${timing.peakHeapMiB.toFixed(1)} MiB`,
        );
      }

      if (!options.compare) continue;
      for (const candidate of candidates.filter((one) => one.name !== 'baseline')) {
        const report = await compareCandidate(fixture.features, trails, candidate, {
          maxDivergences: 5,
        });
        console.log(`  accuracy vs baseline\n${indent(formatReport(report))}`);
      }
    }
  } finally {
    await postgis?.close();
  }
}

function chosen(
  options: Options,
  postgis: PostgisSession | null,
  trails: readonly TrailInput[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const name of options.only) {
    if (name === 'baseline') out.push(baselineCandidate);
    else if (name === 'grid') out.push(gridCandidate());
    else if (name === 'postgis') out.push(postgis!.perTrail());
    else if (name === 'postgis-bulk') out.push(postgis!.bulk(trails));
    else if (name === 'mutants') out.push(...mutants);
    else throw new Error(`unknown candidate ${name}`);
  }
  out.push(...options.cells.map((cellM) => gridCandidate(cellM)));
  return out;
}

/**
 * Every nth trail, never the first n: `assembleTrails` emits relations before ways and relations
 * are the long ones, so a head slice measures a workload the tile does not have.
 */
function sample<T>(all: readonly T[], size: number): T[] {
  if (!Number.isFinite(size) || size >= all.length) return [...all];
  const stride = all.length / size;
  const out: T[] = [];
  for (let i = 0; i < size; i++) out.push(all[Math.floor(i * stride)]!);
  return out;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
