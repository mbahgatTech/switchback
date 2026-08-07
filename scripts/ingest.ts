/**
 * Ingest from the command line.
 *
 *   npm run ingest:drain                 -- run whatever is queued, once
 *   npm run ingest:drain -- --watch      -- keep running it, for local development
 *   npm run ingest:tile -- 12020210      -- fetch one z9 tile now, ignoring the queue
 *   npm run ingest:tile -- --at 53.07,-4.07
 *   npm run ingest:route -- 1225378    -- fetch one long-distance route by relation id
 *
 * `--watch` is the minute-hand local development has no Vercel cron for; `tile` is the smoke
 * test. Everything goes through the same `pipelineDeps` singletons the server uses, so the
 * Overpass concurrency cap is one cap rather than one per entry point.
 *
 * The npm scripts pass `--env-file-if-exists=.env` — unlike Next, this process has nothing
 * that loads `.env` for it, and `-if-exists` keeps the command working where the platform
 * supplies the environment and no file exists.
 */

import { drainIngest, pipelineDeps, processRoute, processTile } from '@switchback/ingest';
import { INGEST_ZOOM, lngLatToTile, tileToQuadkey } from '@switchback/geo';
import { prisma } from '@switchback/db';
import { randomUUID } from 'node:crypto';

const WATCH_INTERVAL_MS = 5_000;

/**
 * This run's name on the queue. Random rather than the literal `cli`, because `drainSlotGate`
 * counts drainers with `count(distinct "lockedBy")` and a shared string reads as one drainer
 * however many are running.
 */
const CLI_WORKER_ID = `cli-${randomUUID().slice(0, 8)}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

async function drain(argv: string[]): Promise<void> {
  const watch = argv.includes('--watch');
  const limit = Number(flag(argv, 'limit') ?? 4);

  do {
    const result = await drainIngest({ limit, workerId: CLI_WORKER_ID });
    if (result.claimed > 0) {
      console.log(`claimed ${result.claimed} · ok ${result.succeeded} · failed ${result.failed}`);
    } else if (!watch) {
      console.log('nothing queued');
    }
    // Only sleep when there was nothing to do. A backlog should drain at full speed.
    if (watch && result.claimed === 0) {
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
    }
  } while (watch);
}

async function tile(argv: string[]): Promise<void> {
  const at = flag(argv, 'at');
  let quadkey = argv.find((arg) => /^[0-3]+$/.test(arg));

  if (at) {
    // `--at lat,lng` — the order every map app shows. Everything downstream is lng/lat.
    const [lat, lng] = at.split(',').map(Number);
    // `Number.isFinite` is not a type guard, so the undefined check needs its own clause:
    // `"53"` splits to one element and would otherwise reach `lngLatToTile`.
    if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      fail(`--at wants "lat,lng", got "${at}"`);
    }
    quadkey = tileToQuadkey(lngLatToTile(lng, lat, INGEST_ZOOM));
  }

  if (!quadkey) fail('Pass a z9 quadkey, or --at lat,lng');
  if (quadkey.length !== INGEST_ZOOM) {
    fail(`Expected a z${INGEST_ZOOM} quadkey (${INGEST_ZOOM} digits), got ${quadkey.length}`);
  }

  console.log(`processing ${quadkey}…`);
  const started = Date.now();
  const result = await processTile(quadkey, {
    ...pipelineDeps(),
    logger: (message, detail) => console.log(`  ${message}`, detail ?? ''),
  });

  console.log(
    `${quadkey}: ${result.trailCount} trails in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

/**
 * Ingest one long-distance route whole, by OSM relation id. Normally queued by tile ingest
 * when it notices a trail belongs to a superroute; exposed here because these are the slowest
 * jobs the pipeline runs and the ones worth watching in a terminal.
 */
async function route(argv: string[]): Promise<void> {
  const raw = argv.find((arg) => /^\d+$/.test(arg));
  if (!raw) fail('Pass an OSM relation id, e.g. 1225378 for the Pacific Crest Trail');

  const osmId = Number(raw);
  console.log(`processing relation ${osmId}…`);
  const started = Date.now();
  const result = await processRoute(osmId, {
    ...pipelineDeps(),
    logger: (message, detail) => console.log(`  ${message}`, detail ?? ''),
  });

  const km = (result.lengthM / 1000).toFixed(1);
  console.log(
    `${result.name ?? osmId}: ${result.status}, ${km} km in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case 'drain':
      await drain(argv);
      break;
    case 'tile':
      await tile(argv);
      break;
    case 'route':
      await route(argv);
      break;
    default:
      fail('Usage: tsx scripts/ingest.ts <drain|tile|route> [options]');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
