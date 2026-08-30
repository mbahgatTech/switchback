/**
 * One tile through the real pipeline with the trail source swapped, so the migrated tile cost is
 * measured rather than derived. `IngestTile.fetchMs` runs from `startedAt` and covers the commit
 * loop too, which is why the source is timed at its own seam instead of subtracted afterwards.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { processTile } from '../../packages/ingest/src/pipeline';
import type { OverpassQuerier, OverpassResponse } from '../../packages/ingest/src/overpass';
import { RAW_FIXTURE_DIR } from '../../packages/ingest/test/support/raw-fixture';
import { fetchTileElements } from './measure-tile-query';
import { getOverpass } from '../../packages/ingest/src/config';

type BBox = [number, number, number, number];

function fixture(shape: string, subject: string): OverpassResponse {
  const packed = readFileSync(join(RAW_FIXTURE_DIR, `${shape}.${subject}.json.gz`));
  return JSON.parse(gunzipSync(packed).toString('utf8')).response as OverpassResponse;
}

/** What each Overpass shape was served from this run, so the report can say so exactly. */
const served = new Map<string, number>();
function note(kind: string): void {
  served.set(kind, (served.get(kind) ?? 0) + 1);
}

class MeasuredSource implements OverpassQuerier {
  tileSourceMs = 0;
  contextMs = 0;

  constructor(
    private readonly mode: 'sql' | 'fixture' | 'live',
    private readonly quadkey: string,
    private readonly bbox: BBox,
    private readonly sql: Client,
  ) {}

  async query(ql: string): Promise<OverpassResponse> {
    if (ql.includes('relation["route"')) {
      const startedAt = performance.now();
      let response: OverpassResponse;
      if (this.mode === 'sql') {
        const { elements } = await fetchTileElements(this.sql, this.bbox);
        response = { elements } as OverpassResponse;
        note('tile:sql-slice');
      } else if (this.mode === 'live') {
        response = await getOverpass().query(ql);
        note('tile:live-overpass');
      } else {
        response = fixture('tile', this.quadkey);
        note('tile:recorded-overpass');
      }
      this.tileSourceMs += performance.now() - startedAt;
      return response;
    }

    // Context is whatever this run is configured for; the migration as scoped does not replace it.
    if (ql.includes('is_in(') || ql.includes('node["natural"')) {
      const kind = ql.includes('is_in(') ? 'region' : 'feature';
      const startedAt = performance.now();
      try {
        if (this.mode === 'live') {
          const response = await getOverpass().query(ql);
          note(`${kind}:live-overpass`);
          return response;
        }
        note(`${kind}:recorded`);
        return fixture(kind, kind === 'region' ? '021231030' : this.quadkey);
      } finally {
        this.contextMs += performance.now() - startedAt;
      }
    }

    note('other:empty');
    return { elements: [] } as OverpassResponse;
  }
}

async function main(): Promise<void> {
  const quadkey = process.argv[2]!;
  const bbox = process.argv.slice(3, 7).map(Number) as BBox;
  const osmDatabase = process.argv[7]!;
  const mode = (process.env.MODE ?? 'sql') as 'sql' | 'fixture' | 'live';

  const sql = new Client({
    host: 'localhost',
    port: 5433,
    user: 'switchback',
    password: 'switchback',
    database: osmDatabase,
  });
  await sql.connect();

  const db = new PrismaClient();
  // Cold every run: an update-path commit is a different cost from an insert-path one, and a
  // warm second run would flatter whichever mode happened to go second.
  await db.$executeRawUnsafe(`DELETE FROM trails WHERE quadkey = '${quadkey}'`);
  await db.$executeRawUnsafe(`DELETE FROM ingest_tiles WHERE quadkey = '${quadkey}'`);

  const source = new MeasuredSource(mode, quadkey, bbox, sql);
  const startedAt = performance.now();
  const result = await processTile(quadkey, {
    db: db as never,
    overpass: source,
    enrichWaypoints: true,
    logger: () => {},
  });
  const totalMs = performance.now() - startedAt;

  const row = await db.$queryRawUnsafe<Array<{ fetchMs: number; trailCount: number }>>(
    `SELECT "fetchMs", "trailCount" FROM ingest_tiles WHERE quadkey = '${quadkey}'`,
  );

  console.log(
    JSON.stringify(
      {
        quadkey,
        mode,
        status: result.status,
        trailsCommitted: result.trailCount,
        skipped: result.skipped,
        failed: result.failed,
        totalMs: Math.round(totalMs),
        tileSourceMs: Math.round(source.tileSourceMs),
        contextMs: Math.round(source.contextMs),
        commitLoopAndRestMs: Math.round(totalMs - source.tileSourceMs),
        ingestTileFetchMs: row[0]?.fetchMs ?? null,
        served: Object.fromEntries(served),
      },
      null,
      2,
    ),
  );

  await db.$disconnect();
  await sql.end();
}

void main();
