/**
 * Viewport to tile coverage: which tiles hold usable data, which are coming, which need
 * queuing. Records intent in `ingest_tiles`/`ingest_jobs` and returns without fetching.
 */

import { JobKind, JobStatus, TileStatus, prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  INGEST_ZOOM,
  MAX_TILES_PER_REQUEST,
  coverBBox,
  coverBBoxFromCentre,
  quadkeyToBBox,
  quadkeyToTile,
} from '@switchback/geo';
import type { BBox } from '@switchback/core';
import { admitIngest } from './backpressure';
import type { IngestRefusal } from './backpressure';
import { spendIngestBudget } from './rate-limit';
import type { IngestPrincipal, RateRefusal } from './rate-limit';
import { enqueue, tileJobKey } from './jobs';
import { isTileFresh, isTileSettled } from './freshness';

/** Priority for a tile someone is looking at, above the 0 a scheduled refresh enqueues with. */
export const VIEWPORT_PRIORITY = 5;

/**
 * Every reason an enqueue can be turned down: the product-wide ceilings, plus the caller's own
 * allowance. Kept as a union of the two rather than one flat list, because they are refusals
 * about different things — one is a statement about the estate, the other about the caller.
 */
export type QueueRefusal = IngestRefusal | RateRefusal;

export interface CoverageResult {
  /** Every tile the bbox touches, whatever its state. */
  quadkeys: string[];
  /** Tiles with data good enough to serve right now. */
  ready: string[];
  /** Tiles with nothing to show yet. The client's "still loading" set. */
  pending: string[];
  /** Ready but past the TTL: served as-is while a refresh runs behind it. */
  refreshing: string[];
  /** Tiles left with outstanding work by this call. What the caller should kick. */
  queued: string[];
  /**
   * True when ingest was refused, so *new* ground here is not on its way. Distinct from
   * "nothing to do", which also leaves `queued` empty. Scoped to new ground: tiles this
   * viewport already has a job for are still coming and still reported in `pending`.
   */
  busy: boolean;
  /**
   * Which refusal, when `busy`. Null otherwise. The three need different sentences: a deep queue
   * clears on its own, a full database needs an operator, and a spent allowance is this caller's
   * alone. Telling somebody to wait out the full database prescribes an action that cannot work.
   */
  busyReason: QueueRefusal | null;
  /** True when the bbox needed more tiles than we will cover in one request. */
  tooLarge: boolean;
  requiredTiles: number;
  maxTiles: number;
}

export interface CoverageOptions {
  db?: PrismaClient;
  now?: Date;
  maxTiles?: number;
  /** Set false for a background sweep that should not jump the queue ahead of live viewports. */
  urgent?: boolean;
  /**
   * Who to charge new ground to. Null — the default — is for callers with no requester behind
   * them, such as a cron or a script, and leaves only the product-wide ceilings applying.
   */
  principal?: IngestPrincipal | null;
}

/**
 * Work out what covering `bbox` requires, and queue whatever is missing. Idempotent by
 * construction: both upserts key on values derived from the quadkey, so twelve simultaneous
 * requests for the same cold viewport produce one tile row and one job apiece.
 */
export async function ensureCoverage(
  bbox: BBox,
  options: CoverageOptions = {},
): Promise<CoverageResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const maxTiles = options.maxTiles ?? MAX_TILES_PER_REQUEST;

  const cover = coverBBox(bbox, INGEST_ZOOM, maxTiles);
  if (cover.tooLarge) {
    return {
      quadkeys: [],
      ready: [],
      pending: [],
      refreshing: [],
      queued: [],
      busy: false,
      busyReason: null,
      tooLarge: true,
      requiredTiles: cover.requiredTiles,
      maxTiles,
    };
  }

  /*
   * The job table is read to tell a tile nobody has asked for apart from one somebody is
   * already waiting on, and both apart from one the retry ladder has given up on.
   * `IngestTile.status` cannot answer either — a row sits at `pending` whether its job is
   * running or died five attempts ago — so trusting it would make a dead tile permanently
   * "in flight" and permanently unqueueable.
   */
  const [existing, jobs] = await Promise.all([
    db.ingestTile.findMany({
      where: { quadkey: { in: cover.quadkeys } },
      select: { quadkey: true, status: true, fetchedAt: true, trailCount: true },
    }),
    db.ingestJob.findMany({
      where: {
        dedupeKey: { in: cover.quadkeys.map(tileJobKey) },
        status: { in: [JobStatus.queued, JobStatus.running, JobStatus.dead] },
      },
      select: { dedupeKey: true, status: true },
    }),
  ]);
  const byKey = new Map(existing.map((tile) => [tile.quadkey, tile]));
  const inFlight = new Set(
    jobs.filter((job) => job.status !== JobStatus.dead).map((job) => job.dedupeKey),
  );
  const givenUp = new Set(
    jobs.filter((job) => job.status === JobStatus.dead).map((job) => job.dedupeKey),
  );

  const ready: string[] = [];
  const pending: string[] = [];
  const refreshing: string[] = [];
  const needsWork: string[] = [];

  for (const quadkey of cover.quadkeys) {
    const tile = byKey.get(quadkey) ?? null;
    if (isTileFresh(tile, now)) {
      ready.push(quadkey);
      continue;
    }

    // Whether there is anything to draw, which the status word alone does not say: a `failed`
    // tile that committed 899 of its 900 trails holds them, and a `ready` tile past the TTL
    // holds the ones it fetched last month.
    const holdsTrails = tile !== null && (isTileSettled(tile.status) || tile.trailCount > 0);

    /*
     * A job the ladder buried after five attempts is not coming back on a poll, and re-queueing
     * it would be worse than useless: `enqueue` revives `dead` with `attempts` reset to zero, so
     * a tile that fails every time would re-run for as long as one map stayed open, never
     * reaching `dead` again. What does bring it back is `reconcileDeadJobs`, off the pump's timer
     * and bounded by `REVIVAL_CEILING` rather than by traffic; `fetchArea` is the way back for a
     * person who will not wait for it.
     */
    if (givenUp.has(tileJobKey(quadkey))) {
      if (holdsTrails) ready.push(quadkey);
      continue;
    }

    needsWork.push(quadkey);
    if (holdsTrails) {
      ready.push(quadkey);
      refreshing.push(quadkey);
    } else {
      pending.push(quadkey);
    }
  }

  /*
   * The depth ceiling judges only *new ground*, which is the thing it exists to bound.
   * `enqueue` upserts on `dedupeKey`, so refusing a quadkey already queued protects nothing —
   * while the refusal clears `pending`, and `explore.tsx` gates `refetchInterval` on
   * `pendingTiles.length`, so the reader whose tiles were about to land stops polling for them.
   */
  const newGround = needsWork.filter((quadkey) => !inFlight.has(tileJobKey(quadkey)));

  // Every outstanding tile is still handed to `queueTiles`; only `newGround` is what admission
  // may judge. Re-enqueueing an in-flight tile writes no row but does raise the job's
  // priority, which is how a tile a background sweep queued at 0 jumps the line.
  const enqueued = await queueTiles(db, needsWork, {
    urgent: options.urgent ?? true,
    newGround,
    principal: options.principal ?? null,
    now,
  });
  const queued = enqueued.queued;

  /*
   * Nothing queued despite *new* ground outstanding means backpressure refused it, and the
   * refused tiles must not be reported as `pending`: that is the client's "still loading" set
   * and it polls every few seconds while non-empty, so a database under enough pressure to
   * refuse ingest would take a poll storm from every open map over tiles that never arrive.
   * They fall back to whatever we hold, and `busy`/`busyReason` say it in words instead.
   * Tiles already in flight are exempt — they are coming, and worth polling for.
   */
  const busy = newGround.length > 0 && queued.length === 0;
  const stillComing = pending.filter((quadkey) => inFlight.has(tileJobKey(quadkey)));

  return {
    quadkeys: cover.quadkeys,
    ready,
    pending: busy ? stillComing : pending,
    refreshing,
    queued,
    busy,
    busyReason: busy ? enqueued.refused : null,
    tooLarge: false,
    requiredTiles: cover.requiredTiles,
    maxTiles,
  };
}

/** What an enqueue call did, and — when it did nothing — why. */
export interface QueueOutcome {
  /** The quadkeys now on the queue. Empty when admission refused. */
  queued: string[];
  /** The refusal, or `null` when nothing was refused. */
  refused: QueueRefusal | null;
}

/**
 * Register tiles and enqueue their fetches.
 *
 * The tile row is written before the job: if the process dies between the two, the worst case
 * is a tile stuck at `pending` with no job, which the next viewport request repairs because a
 * `pending` tile is never fresh. The reverse order leaves a job pointing at nothing.
 *
 * `newGround` narrows what admission is *judged* on without narrowing what is enqueued — a
 * quadkey already queued adds no row when re-enqueued, so refusing it bounds nothing while
 * costing the reader their poll. The deliberate area fetch is asking for new ground by
 * definition and leaves it alone.
 */
export async function queueTiles(
  db: PrismaClient,
  quadkeys: readonly string[],
  options: {
    urgent?: boolean;
    priority?: number;
    /** The subset of `quadkeys` with nothing already on the queue. Defaults to all of them. */
    newGround?: readonly string[];
    /** Who to charge the new ground to. Null leaves only the product-wide ceilings applying. */
    principal?: IngestPrincipal | null;
    now?: Date;
  } = {},
): Promise<QueueOutcome> {
  if (quadkeys.length === 0) return { queued: [], refused: null };

  const newGround = options.newGround ?? quadkeys;

  // Nothing new to bound: the upserts below are all collisions, so they keep the priority
  // bump without asking the guard about work it has already admitted once. This is also what
  // keeps a reader panning over ground we already hold off the rate limiter entirely.
  if (newGround.length > 0) {
    // The one place every trail-ingest path crosses, and so where backpressure belongs.
    const refused = await admitIngest(db);
    if (refused !== null) return { queued: [], refused };

    /*
     * The caller's own share, taken only once the estate has said yes — charging for tiles the
     * ceiling was about to refuse would bill somebody for work that never happened.
     */
    const principal = options.principal ?? null;
    if (principal !== null) {
      const budget = await spendIngestBudget(db, principal, newGround.length, options.now);
      if (!budget.spent) return { queued: [], refused: 'rate-limit' };
    }
  }

  // Explicit priority wins; `urgent` is the two-value shorthand the viewport path uses.
  const priority = options.priority ?? (options.urgent === false ? 0 : VIEWPORT_PRIORITY);

  for (const quadkey of quadkeys) {
    const { x, y, z } = quadkeyToTile(quadkey);
    const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(quadkey);

    await db.ingestTile.upsert({
      where: { quadkey },
      // A re-queue must not reset `fetchedAt` or `trailCount`: a stale-but-ready tile is
      // still serving those trails until the refresh lands.
      create: { quadkey, x, y, z, status: TileStatus.pending, bboxW, bboxS, bboxE, bboxN },
      update: {},
    });

    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey(quadkey),
      payload: { quadkey },
      priority,
    });
  }

  return { queued: [...quadkeys], refused: null };
}

/**
 * How much ground one press of "fetch this area" may queue. Ninety-six z9 tiles is roughly
 * Washington State plus its neighbours, and at two Overpass queries in flight it is minutes of
 * background work — the UI says so.
 */
export const MAX_AREA_TILES = 96;

/**
 * Priority for an area someone asked for by name: below `VIEWPORT_PRIORITY`, because a person
 * staring at a blank viewport is waiting harder than one who kicked off a sweep, and above the
 * 0 a background refresh uses, because they did ask.
 */
export const AREA_PRIORITY = 2;

export interface AreaCoverage {
  /** Every tile this survey covers, nearest the centre of the box first. */
  quadkeys: string[];
  /** Holding data inside the TTL. Nothing to do for these. */
  fresh: string[];
  /** Needing work: never fetched, previously failed, or past the TTL. */
  outstanding: string[];
  /** Of `outstanding`, the ones with nothing at all to show yet. */
  missing: string[];
  /** Of `outstanding`, the ones with a job queued or running right now. */
  working: string[];
  /** How many tiles the box actually spans, before the cap. */
  requiredTiles: number;
  maxTiles: number;
  /** True when the box spans more than `maxTiles`, so this is the middle of it. */
  capped: boolean;
}

export interface AreaOptions {
  db?: PrismaClient;
  now?: Date;
  maxTiles?: number;
  /** Who to charge new ground to. Null leaves only the product-wide ceilings applying. */
  principal?: IngestPrincipal | null;
}

/**
 * Report what we hold for an arbitrary area, without queueing anything. `ensureCoverage`
 * cannot answer this: it refuses outright past twelve tiles, which is right for a map that
 * panned and useless for a UI offering "fetch this area".
 */
export async function surveyArea(bbox: BBox, options: AreaOptions = {}): Promise<AreaCoverage> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const maxTiles = options.maxTiles ?? MAX_AREA_TILES;

  const cover = coverBBoxFromCentre(bbox, INGEST_ZOOM, maxTiles);

  const [tiles, jobs] = await Promise.all([
    db.ingestTile.findMany({
      where: { quadkey: { in: cover.quadkeys } },
      select: { quadkey: true, status: true, fetchedAt: true, trailCount: true },
    }),
    db.ingestJob.findMany({
      where: {
        dedupeKey: { in: cover.quadkeys.map(tileJobKey) },
        status: { in: [JobStatus.queued, JobStatus.running] },
      },
      select: { dedupeKey: true },
    }),
  ]);

  const byKey = new Map(tiles.map((tile) => [tile.quadkey, tile]));
  const inFlight = new Set(jobs.map((job) => job.dedupeKey));

  const fresh: string[] = [];
  const outstanding: string[] = [];
  const missing: string[] = [];
  const working: string[] = [];

  for (const quadkey of cover.quadkeys) {
    const tile = byKey.get(quadkey) ?? null;
    if (isTileFresh(tile, now)) {
      fresh.push(quadkey);
      continue;
    }
    outstanding.push(quadkey);
    // Whether the tile has anything drawn, not what its status word is: a `failed` tile that
    // committed all but one of its trails is not missing.
    if (!isTileSettled(tile?.status ?? TileStatus.pending) && (tile?.trailCount ?? 0) === 0) {
      missing.push(quadkey);
    }
    if (inFlight.has(tileJobKey(quadkey))) working.push(quadkey);
  }

  return {
    quadkeys: cover.quadkeys,
    fresh,
    outstanding,
    missing,
    working,
    requiredTiles: cover.requiredTiles,
    maxTiles,
    capped: cover.capped,
  };
}

export interface AreaRequest extends AreaCoverage {
  /** What this call put on the queue. What the caller should kick. */
  queued: string[];
  /** True when admission refused, so nothing was queued. */
  busy: boolean;
  /** Which refusal, when `busy`. The three need different sentences on screen. */
  busyReason: QueueRefusal | null;
}

/**
 * Queue every outstanding tile in an area, because somebody asked for it. Pressing twice is
 * free: fresh tiles are skipped and the rest dedupe onto the first press's jobs.
 */
export async function requestArea(bbox: BBox, options: AreaOptions = {}): Promise<AreaRequest> {
  const db = options.db ?? prisma;
  const area = await surveyArea(bbox, options);

  if (area.outstanding.length === 0) {
    return { ...area, queued: [], busy: false, busyReason: null };
  }

  // `queueTiles` runs the depth check, so there is none here. `newGround` is the outstanding
  // tiles minus the ones `surveyArea` already found a job for, so a second press is not
  // refused for work the first press queued — that would report a fetch as turned down while
  // it was running.
  const working = new Set(area.working);
  const { queued, refused } = await queueTiles(db, area.outstanding, {
    priority: AREA_PRIORITY,
    newGround: area.outstanding.filter((quadkey) => !working.has(quadkey)),
    principal: options.principal ?? null,
    now: options.now,
  });
  if (queued.length === 0) return { ...area, queued: [], busy: true, busyReason: refused };

  return {
    ...area,
    queued,
    working: [...new Set([...area.working, ...queued])],
    busy: false,
    busyReason: null,
  };
}
