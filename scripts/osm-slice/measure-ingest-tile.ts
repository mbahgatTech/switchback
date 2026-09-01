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
import { RAW_FIXTURE_DIR } from './raw-fixtures';
import { fetchTileElements } from './measure-tile-query';
import { fetchContext } from './measure-context-query';
import { getOverpass } from '../../packages/ingest/src/config';

type BBox = [number, number, number, number];

/**
 * Where each Overpass shape comes from this run. `slice` is the migration as this gate scopes it —
 * every read the pipeline makes off the local slice; `live` is the unmigrated pipeline; `sql`
 * keeps the first gate's narrower scope, where only the trail source moved.
 */
type Mode = 'slice' | 'sql' | 'fixture' | 'live';

function fixture(shape: string, subject: string): OverpassResponse {
  const packed = readFileSync(join(RAW_FIXTURE_DIR, `${shape}.${subject}.json.gz`));
  const recorded = JSON.parse(gunzipSync(packed).toString('utf8')) as {
    response: OverpassResponse;
  };
  return recorded.response;
}

/** What each Overpass shape was served from this run, so the report can say so exactly. */
const served = new Map<string, number>();
const unmatched: string[] = [];
function note(kind: string): void {
  served.set(kind, (served.get(kind) ?? 0) + 1);
}

class MeasuredSource implements OverpassQuerier {
  tileSourceMs = 0;
  contextMs = 0;

  constructor(
    private readonly mode: Mode,
    private readonly quadkey: string,
    private readonly bbox: BBox,
    private readonly sql: Client,
  ) {}

  async query(ql: string): Promise<OverpassResponse> {
    if (ql.includes('relation["route"')) {
      const startedAt = performance.now();
      let response: OverpassResponse;
      if (this.mode === 'sql' || this.mode === 'slice') {
        const { elements } = await fetchTileElements(this.sql, this.bbox);
        response = { elements };
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

    if (ql.includes('is_in(') || ql.includes('node["natural"')) {
      const kind = ql.includes('is_in(') ? 'region' : 'feature';
      const startedAt = performance.now();
      try {
        if (this.mode === 'live') {
          const response = await getOverpass().query(ql);
          note(`${kind}:live-overpass`);
          return response;
        }
        if (this.mode === 'slice') {
          // Both halves come off the slice. `fetchContext` runs them as one pair, so asking it
          // twice would double the work — the region call takes the cached pair's region half.
          const centre: [number, number] = [
            (this.bbox[0] + this.bbox[2]) / 2,
            (this.bbox[1] + this.bbox[3]) / 2,
          ];
          this.context ??= fetchContext(this.sql, this.bbox, centre);
          const answer = await this.context;
          note(`${kind}:sql-slice`);
          return { elements: kind === 'region' ? answer.region : answer.features };
        }
        note(`${kind}:recorded`);
        return fixture(kind, kind === 'region' ? '021231030' : this.quadkey);
      } finally {
        this.contextMs += performance.now() - startedAt;
      }
    }

    note('other:empty');
    // An unmatched shape is a fallback the slice did not answer and a live run would have paid
    // for. Naming it is what keeps the two arms comparable rather than quietly asymmetric.
    unmatched.push(ql.replace(/\s+/g, ' ').slice(0, 120));
    return { elements: [] };
  }

  /** The one context pair this tile needs, shared by the region and feature callers. */
  private context?: Promise<Awaited<ReturnType<typeof fetchContext>>>;
}

async function main(): Promise<void> {
  const quadkey = process.argv[2]!;
  const bbox = process.argv.slice(3, 7).map(Number) as BBox;
  const osmDatabase = process.argv[7]!;
  const mode = (process.env.MODE ?? 'slice') as Mode;

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
    db,
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
        unmatched,
      },
      null,
      2,
    ),
  );

  await db.$disconnect();
  await sql.end();
}

void main();
