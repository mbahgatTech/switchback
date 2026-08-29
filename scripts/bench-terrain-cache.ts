/**
 * Cold and warm passes over one z9 tile's terrain footprint, against the real origin.
 *
 * The cold pass is what every invocation does today: 256 z13 terrarium tiles from AWS. The warm
 * pass is the same work with the shared tier already populated and a fresh in-process LRU, which
 * is the state a retry, a subdivided child tile or a cold start actually starts from.
 *
 *   npx tsx scripts/bench-terrain-cache.ts 021231030 --tiles 64
 *
 * The store is a directory, so the warm figure is a floor on the round trips removed rather than
 * a prediction of R2's latency — the per-tile origin distribution printed below is what to
 * compare a bucket against.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERRARIUM_ZOOM, quadkeyToTile } from '@switchback/geo';
import { TerrainCache, TerrainSource, directoryTerrainStore } from '@switchback/ingest';

interface Pass {
  label: string;
  elapsedMs: number;
  tiles: number;
  nulls: number;
  perTileMs: number[];
  stats: { hits: number; misses: number; unavailable: number };
}

async function main(): Promise<void> {
  const [quadkey = '021231030', ...flags] = process.argv.slice(2);
  const limit = Number(flags[flags.indexOf('--tiles') + 1]) || 256;
  const footprint = terrainFootprint(quadkey).slice(0, limit);
  const root = await mkdtemp(join(tmpdir(), 'sb-terrain-bench-'));

  console.log(`quadkey ${quadkey} — ${footprint.length} z${TERRARIUM_ZOOM} tiles, store ${root}`);

  try {
    const cold = await pass('cold  (empty store)', root, footprint);
    report(cold);
    const warm = await pass('warm  (populated)  ', root, footprint);
    report(warm);

    const saved = cold.elapsedMs - warm.elapsedMs;
    console.log(
      `\nspeed-up ${(cold.elapsedMs / warm.elapsedMs).toFixed(1)}x — ${(saved / 1000).toFixed(1)} s off ${(cold.elapsedMs / 1000).toFixed(1)} s`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every z13 tile under a z9 quadkey: four zoom levels, so 16 by 16. */
function terrainFootprint(quadkey: string): Array<{ x: number; y: number }> {
  const tile = quadkeyToTile(quadkey);
  const span = 2 ** (TERRARIUM_ZOOM - tile.z);
  const out: Array<{ x: number; y: number }> = [];
  for (let dx = 0; dx < span; dx++) {
    for (let dy = 0; dy < span; dy++) out.push({ x: tile.x * span + dx, y: tile.y * span + dy });
  }
  return out;
}

/** One pass with a fresh in-process LRU, which is what makes the shared tier the thing measured. */
async function pass(
  label: string,
  root: string,
  footprint: Array<{ x: number; y: number }>,
): Promise<Pass> {
  const source = new TerrainSource({ cache: new TerrainCache(directoryTerrainStore(root)) });
  const perTileMs: number[] = [];
  let nulls = 0;

  const started = Date.now();
  await Promise.all(
    footprint.map(async ({ x, y }) => {
      const at = Date.now();
      const tile = await source.tile(TERRARIUM_ZOOM, x, y);
      perTileMs.push(Date.now() - at);
      if (tile === null) nulls += 1;
    }),
  );
  const elapsedMs = Date.now() - started;
  await source.flushWrites();

  return {
    label,
    elapsedMs,
    tiles: footprint.length,
    nulls,
    perTileMs,
    stats: source.sharedCacheStats,
  };
}

function report(run: Pass): void {
  const { hits, misses, unavailable } = run.stats;
  const rate = hits + misses === 0 ? 0 : (hits / (hits + misses)) * 100;
  const sorted = [...run.perTileMs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;

  console.log(
    `${run.label}  ${(run.elapsedMs / 1000).toFixed(1)} s  ` +
      `hit rate ${rate.toFixed(1)}% (${hits} hit, ${misses} miss, ${unavailable} unavailable)  ` +
      `per tile p50 ${at(0.5)} ms p90 ${at(0.9)} ms max ${at(1)} ms  ` +
      `${run.nulls} with no tile`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
