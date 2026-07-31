/**
 * Viewport → tile coverage. The front door of the on-demand design.
 *
 * A request arrives with a bounding box. This module answers three questions in one round
 * trip: which tiles already hold usable data, which are still coming, and which need
 * queuing. It never fetches anything itself — it records intent in `ingest_tiles` and
 * `ingest_jobs` and returns. The caller decides whether to also kick the work off
 * immediately (`waitUntil`) or leave it to the cron.
 *
 * The distinction between `pending` and `refreshing` is what keeps the map honest. A tile
 * that has never been fetched has nothing to show, so the client should say so. A tile
 * whose data is thirty-one days old has plenty to show while the refresh runs, and putting
 * a spinner over it would be a lie about the state of the map.
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
import { enqueue, tileJobKey } from './jobs';
import { isTileFresh } from './pipeline';

/**
 * Priority for a tile someone is actually looking at.
 *
 * Above the 0 a scheduled refresh enqueues with, so a cron drain that finds both in the
 * table serves the person waiting on a blank map first.
 */
export const VIEWPORT_PRIORITY = 5;

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
   * True when ingest was refused, so *new* ground here is not on its way.
   *
   * Distinct from "nothing to do": `queued` is empty in both cases, and the client needs to
   * tell a fully cached viewport apart from one whose fetch was turned down.
   *
   * Scoped to new ground on purpose. Tiles this viewport already has a job for are still
   * coming and are still reported in `pending`, so a refusal about ground nobody has asked
   * for yet does not stop the reader's own tiles from landing — nor stop the client polling
   * for them.
   */
  busy: boolean;
  /**
   * Which refusal, when `busy`. Null otherwise.
   *
   * Carried rather than collapsed into the boolean because the two refusals need different
   * sentences: a deep queue clears on its own and "try again in a few minutes" is true of
   * it; a full database does not, and telling somebody to wait for it is prescribing an
   * action that cannot work.
   */
  busyReason: IngestRefusal | null;
  /** True when the bbox needed more tiles than we will cover in one request. */
  tooLarge: boolean;
  requiredTiles: number;
  maxTiles: number;
}

export interface CoverageOptions {
  db?: PrismaClient;
  now?: Date;
  maxTiles?: number;
  /**
   * Set false for a background sweep that should not jump the queue ahead of live
   * viewports.
   */
  urgent?: boolean;
}

/**
 * Work out what covering `bbox` requires, and queue whatever is missing.
 *
 * Idempotent by construction: the tile upsert and the job upsert both key on values
 * derived from the quadkey, so twelve simultaneous requests for the same cold viewport
 * produce one tile row and one job apiece.
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
   * Both lookups at once, the same pair `surveyArea` makes.
   *
   * The job table is read for one reason: to tell a tile nobody has asked for apart from a
   * tile somebody already asked for and is waiting on. `IngestTile.status` cannot answer
   * that — a row sits at `pending` whether its job is running or died five attempts ago, so
   * trusting it would make a dead tile permanently "in flight" and permanently unqueueable.
   * `dedupeKey` is unique-indexed, so this is a keyed lookup over a list we already hold.
   */
  const [existing, jobs] = await Promise.all([
    db.ingestTile.findMany({
      where: { quadkey: { in: cover.quadkeys } },
      select: { quadkey: true, status: true, fetchedAt: true },
    }),
    db.ingestJob.findMany({
      where: {
        dedupeKey: { in: cover.quadkeys.map(tileJobKey) },
        status: { in: [JobStatus.queued, JobStatus.running] },
      },
      select: { dedupeKey: true },
    }),
  ]);
  const byKey = new Map(existing.map((tile) => [tile.quadkey, tile]));
  const inFlight = new Set(jobs.map((job) => job.dedupeKey));

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
    needsWork.push(quadkey);
    // `ready`/`empty` past the TTL still has trails in the table; a `running` tile that a
    // previous request queued has none yet, and neither does a `failed` one.
    if (tile?.status === TileStatus.ready || tile?.status === TileStatus.empty) {
      ready.push(quadkey);
      refreshing.push(quadkey);
    } else {
      pending.push(quadkey);
    }
  }

  /*
   * Split the outstanding tiles by whether anything is already coming for them, because
   * admission has no business seeing the ones that are.
   *
   * `enqueue` upserts on `dedupeKey`. Re-enqueueing a quadkey whose job is already `queued`
   * or `running` writes no row and costs nothing, so refusing it protects nothing — while
   * the refusal itself is expensive: `queueTiles` returned `queued: []` for the whole set,
   * which made `busy` true, which cleared `pending`, which stopped the client polling
   * (`explore.tsx` gates `refetchInterval` on `pendingTiles.length`). The reader whose tiles
   * were genuinely in flight and about to land got told fetching was paused, and the map
   * stopped updating until they panned — into another refusal. Under master, with no guard
   * at all, that same reader kept polling and watched the trails arrive.
   *
   * So the depth ceiling now judges only *new ground*, which is the thing it exists to
   * bound. Tiles already on the queue are reported as what they are: coming.
   */
  const newGround = needsWork.filter((quadkey) => !inFlight.has(tileJobKey(quadkey)));

  // Every outstanding tile is still handed to `queueTiles`; only `newGround` is what
  // admission is allowed to judge. Re-enqueueing an in-flight tile writes no row — `enqueue`
  // upserts on `dedupeKey` — but it does raise the job's priority, which is how a tile a
  // background sweep queued at 0 jumps the line the moment somebody is looking at it.
  // Dropping those from the call would have quietly cost that promotion.
  const enqueued = await queueTiles(db, needsWork, {
    urgent: options.urgent ?? true,
    newGround,
  });
  const queued = enqueued.queued;

  /*
   * Nothing queued despite *new* ground outstanding means backpressure refused it, and what
   * the client is told about that matters more than it looks.
   *
   * Reporting the refused tiles as `pending` would be truthful and much worse. `pending` is
   * the client's "still loading" set, and it polls every few seconds for as long as it is
   * non-empty — so a database under enough pressure to refuse ingest would get a poll storm
   * from every open map, forever, over tiles that are never going to arrive. The same
   * argument `coverageFor` makes in the trails router about a failed coverage read.
   *
   * So the refused tiles fall back to whatever we hold: `ready` keeps anything with data
   * behind it, the rest simply are not claimed to be coming, and `busy` carries the reason
   * up so the coverage note can say it in words instead of leaving a spinner to imply it.
   *
   * Tiles that were already in flight are exempt from all of that. They *are* coming, they
   * are worth polling for, and a refusal about other ground says nothing about them.
   *
   * `busyReason` rides along because the two refusals are not the same sentence. "Try again
   * in a few minutes" is true of a deep queue and false of a full database — waiting does
   * not empty one, and the note must not prescribe an action that cannot work.
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
  refused: IngestRefusal | null;
}

/**
 * Register tiles and enqueue their fetches.
 *
 * The tile row is written before the job, not after. If the process dies between the two,
 * the worst case is a tile stuck at `pending` with no job — which the next viewport
 * request over the same area repairs, because a `pending` tile is never fresh. The reverse
 * order would leave a job pointing at a tile row that does not exist, and the handler
 * would have to invent one anyway.
 *
 * Returns the refusal rather than an empty array alone. The reason was already computed —
 * `admitIngest` types it — and dropping it here is what made a full database and a deep
 * queue arrive at the reader as the same sentence.
 *
 * `newGround` narrows what admission is *judged* on without narrowing what is enqueued. A
 * quadkey whose job is already `queued` or `running` adds no row when re-enqueued — the
 * dedupe key collides — so refusing it bounds nothing, while the refusal costs the reader
 * their poll. Callers that know which of their tiles are already in flight pass the rest;
 * callers that do not, and the deliberate area fetch which is asking for genuinely new
 * ground by definition, leave it alone and every quadkey counts.
 */
export async function queueTiles(
  db: PrismaClient,
  quadkeys: readonly string[],
  options: {
    urgent?: boolean;
    priority?: number;
    /** The subset of `quadkeys` with nothing already on the queue. Defaults to all of them. */
    newGround?: readonly string[];
  } = {},
): Promise<QueueOutcome> {
  if (quadkeys.length === 0) return { queued: [], refused: null };

  const newGround = options.newGround ?? quadkeys;

  // Nothing new to bound. The upserts below are all collisions, so they add no rows and no
  // fetches — running them keeps the priority bump without asking the guard's permission for
  // work the guard has already admitted once.
  if (newGround.length > 0) {
    // The one place every trail-ingest path crosses, and so the place backpressure belongs.
    // See `backpressure.ts` for why it is not at the call sites any more.
    const refused = await admitIngest(db);
    if (refused !== null) return { queued: [], refused };
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

// ---------------------------------------------------------------------------
// Deliberate area fetches
// ---------------------------------------------------------------------------

/**
 * How much ground one press of "fetch this area" may queue.
 *
 * Ninety-six z9 tiles is roughly Washington State plus its neighbours — about as much as a
 * person means by "this area" when they have zoomed out to pick a weekend. Each tile is one
 * Overpass query and the client holds two in flight, so a full ninety-six is minutes of
 * background work; the UI says so rather than pretending otherwise.
 */
export const MAX_AREA_TILES = 96;

/**
 * Priority for an area someone asked for by name.
 *
 * Between the two things it must not disturb. Below `VIEWPORT_PRIORITY`, because a person
 * staring at a blank twelve-tile viewport is waiting harder than one who kicked off a
 * five-minute sweep and went to make tea. Above the 0 a background refresh uses, because
 * they did ask.
 */
export const AREA_PRIORITY = 2;

/*
 * Backpressure lives in `backpressure.ts` now, and `MAX_TILE_QUEUE_DEPTH` with it.
 *
 * It was here because this file held the only call site that checked it. That was the bug:
 * `requestArea` is the path a person reaches by pressing a button, and the two paths that
 * queue without anybody pressing anything — the viewport ingest above and the routing
 * ingest in `network.ts` — went round it. The check now sits inside `queueTiles` and
 * `queueNetworkTiles`, which every writing path crosses, and counts all three job kinds
 * rather than `ingest_tile` alone.
 *
 * Re-exported nowhere: import it from `./backpressure`, which is the one place it lives.
 */

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
}

/**
 * Report what we hold for an arbitrary area, without queueing anything.
 *
 * The read half of the deliberate path. `ensureCoverage` cannot answer this question: it
 * refuses outright past twelve tiles, which is the correct behaviour for a map that panned
 * and a useless one for a UI that wants to offer *fetch this area* and needs to know first
 * whether there is anything left to fetch.
 */
export async function surveyArea(bbox: BBox, options: AreaOptions = {}): Promise<AreaCoverage> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const maxTiles = options.maxTiles ?? MAX_AREA_TILES;

  const cover = coverBBoxFromCentre(bbox, INGEST_ZOOM, maxTiles);

  const [tiles, jobs] = await Promise.all([
    db.ingestTile.findMany({
      where: { quadkey: { in: cover.quadkeys } },
      select: { quadkey: true, status: true, fetchedAt: true },
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
    // `ready`/`empty` past the TTL still has trails behind it; anything else has nothing.
    if (tile?.status !== TileStatus.ready && tile?.status !== TileStatus.empty) {
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
  /** Which refusal, when `busy`. The two need different sentences on screen. */
  busyReason: IngestRefusal | null;
}

/**
 * Queue every outstanding tile in an area, because somebody asked for it.
 *
 * Idempotent in the way that matters: pressing twice is free. Fresh tiles are skipped, and
 * the tiles that are not fresh dedupe onto the jobs the first press created — so the second
 * press queues nothing new and simply reports the same progress back.
 */
export async function requestArea(bbox: BBox, options: AreaOptions = {}): Promise<AreaRequest> {
  const db = options.db ?? prisma;
  const area = await surveyArea(bbox, options);

  if (area.outstanding.length === 0) {
    return { ...area, queued: [], busy: false, busyReason: null };
  }

  // No depth check here any more: `queueTiles` runs it, and running it in both places was
  // how the routing queue ended up unguarded — a check at one call site guards one call
  // site. An empty return with work outstanding is the refusal, and it now says which.
  //
  // `newGround` is the outstanding tiles minus the ones `surveyArea` already found a job
  // for, so admission judges only what this press actually adds. Pressing "fetch this area"
  // twice must not be refused the second time for work the first press queued — the second
  // enqueue writes no row, and the refusal would tell somebody their fetch was turned down
  // while it was running. The set is already computed here, so this costs nothing.
  const working = new Set(area.working);
  const { queued, refused } = await queueTiles(db, area.outstanding, {
    priority: AREA_PRIORITY,
    newGround: area.outstanding.filter((quadkey) => !working.has(quadkey)),
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
