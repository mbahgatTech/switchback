/**
 * Trails: browse, search, detail.
 *
 * Every viewport-shaped procedure here does the same two things in the same order. It asks
 * `ensureCoverage` what we hold for the requested box — which also queues whatever is
 * missing — and then serves whatever is already in the table. It never waits for the fetch.
 * A cold viewport returns an empty list and a set of pending quadkeys in a few
 * milliseconds, and the client re-asks as those tiles land.
 *
 * That ordering is the whole on-demand design. Blocking on Overpass would make a first
 * visit to an unfetched region take thirty seconds and fail whenever Overpass is busy; this
 * way the map is always as fast as Postgres and merely less complete for a moment.
 *
 * **Why bbox overlap rather than `ST_Intersects` for the viewport predicate.** `Trail`
 * carries its own bbox in four indexed float columns, so "does this trail's box overlap the
 * viewport" is a plain Prisma `where` that composes with every facet and paginates
 * properly. Routing it through PostGIS would mean fetching a capped candidate id list first
 * and intersecting it with the facets afterwards, which silently drops matches whenever the
 * cap bites. The cost is a handful of false positives — a Z-shaped trail whose box overlaps
 * the viewport while its line does not — which for map browsing is arguably the better
 * answer anyway.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bboxSchema, lineStringSchema, lngLatSchema, trailSearchSchema } from '@switchback/core';
import type {
  ActivityType,
  AreaSummary,
  BBox,
  LineString,
  TileCoverage,
  TrailDetail,
  TrailMapItem,
  TrailSearch,
} from '@switchback/core';
import { Prisma, trailIdsNear } from '@switchback/db';
import { encodeBase64, toFitCourse, toRouteGpx } from '@switchback/geo';
import {
  drainIngest,
  ensureCoverage,
  requestArea,
  surveyArea,
  tileJobKey,
} from '@switchback/ingest';
import type { AreaCoverage, CoverageResult } from '@switchback/ingest';
import { decodeCursor, encodeCursor } from '../cursor';
import { readProfile } from '../profiles';
import { summarySelect, toSummary } from '../trail-shape';
import { deliberateServerError, publicProcedure, router } from '../trpc';
import type { Context } from '../context';
import { photoSelect, toPhoto } from './photos';
import type { TrailPhoto } from './photos';

/**
 * How many text-search candidates to rank before applying facets.
 *
 * Full-text ranking has to happen in one raw query, so the facets are applied afterwards in
 * Prisma. That is only sound while the ranked set is large enough to survive filtering —
 * 500 comfortably covers "waterfall" narrowed to hard loops over 10 km. Past that the tail
 * is lost, which is the usual bargain for ranked search and the reason the UI leads with a
 * map rather than with page 40.
 */
const TEXT_CANDIDATE_CAP = 500;

/** Candidate cap for a radius search, before facets. */
const NEAR_CANDIDATE_CAP = 300;

/** Radius for "near me" when the client does not say. Roughly a half-hour drive. */
const DEFAULT_RADIUS_M = 30_000;

/** How many queued tiles one request will try to drain on its response's coattails. */
const MAX_INLINE_DRAIN = 4;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

const mapSelect = { ...summarySelect, geometryJson: true } satisfies Prisma.TrailSelect;
type MapRow = Prisma.TrailGetPayload<{ select: typeof mapSelect }>;

const detailSelect = {
  ...mapSelect,
  description: true,
  surface: true,
  sacScale: true,
  dogsAllowed: true,
  wheelchairAccessible: true,
  feeRequired: true,
  osmType: true,
  osmId: true,
  sourceUpdatedAt: true,
  profile: { select: { points: true } },
  waypoints: {
    select: { id: true, kind: true, name: true, lng: true, lat: true, eleM: true, distM: true },
    // Along the trail first, then the off-route features whose `distM` is null.
    orderBy: [{ distM: { sort: 'asc', nulls: 'last' } }, { kind: 'asc' }],
  },
} satisfies Prisma.TrailSelect;

type DetailRow = Prisma.TrailGetPayload<{ select: typeof detailSelect }>;

/**
 * Read the stored line.
 *
 * Parsed rather than cast, because this column is written as `Json` and a malformed line
 * would otherwise reach a map renderer as `undefined.coordinates`. A row that fails is
 * dropped from the response rather than failing the whole viewport — one bad trail should
 * not blank the map.
 */
function readGeometry(value: Prisma.JsonValue): LineString | null {
  const parsed = lineStringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Everything the two export procedures need, and the same thing for both.
 *
 * One loader rather than a select in each, so GPX and FIT can never disagree about what
 * "the trail" is. The `points` it returns are the 25 m elevation profile when there is one,
 * because a device handed a line with no ground under it invents the ascent from whatever
 * DEM it ships with, and falls back to the rendered 5 m line at zero elevation when the
 * profile has not been derived yet. A flat file is a poor export; a missing one is worse.
 *
 * `stampedAt` is `sourceUpdatedAt` where ingest has set it, `updatedAt` otherwise — see the
 * FIT procedure for why the export is stamped with the trail rather than with the clock.
 */
async function loadForExport(
  db: Context['db'],
  trailId: string,
): Promise<{
  slug: string;
  name: string;
  description: string | null;
  activityType: ActivityType;
  estimatedTimeS: number;
  stampedAt: Date;
  points: Array<{ lng: number; lat: number; eleM: number }>;
}> {
  const row = await db.trail.findUnique({
    where: { id: trailId },
    select: {
      slug: true,
      name: true,
      description: true,
      activityTypes: true,
      estimatedTimeS: true,
      sourceUpdatedAt: true,
      updatedAt: true,
      geometryJson: true,
      profile: { select: { points: true } },
    },
  });
  if (!row) throw notFound();

  const profile = readProfile(row.profile?.points);
  const points =
    profile.length >= 2
      ? profile.map((point) => ({ lng: point.lng, lat: point.lat, eleM: point.eleM }))
      : (readGeometry(row.geometryJson)?.coordinates ?? []).map(([lng, lat]) => ({
          lng,
          lat,
          eleM: 0,
        }));
  if (points.length === 0) throw notFound('That trail has no usable geometry.');

  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    // The first declared activity, which ingest orders with the trail's primary use first.
    // A file carries one sport; a path tagged for both feet and tyres exports as the former.
    activityType: row.activityTypes[0] ?? 'hiking',
    estimatedTimeS: row.estimatedTimeS,
    stampedAt: row.sourceUpdatedAt ?? row.updatedAt,
    points,
  };
}

function toMapItem(row: MapRow): TrailMapItem | null {
  const geometry = readGeometry(row.geometryJson);
  if (!geometry) return null;
  return { ...toSummary(row), geometry };
}

function toDetail(row: DetailRow): TrailDetail {
  const geometry = readGeometry(row.geometryJson);
  if (!geometry) {
    // Ingest writes geometry and stats in one transaction, so this is a corrupted row
    // rather than a trail that simply has not been enriched yet. Marked so the message
    // survives serialisation — it names the one thing that is wrong with this trail, and
    // it stays a 500 because `NOT_FOUND` would be rendered as a 404 page instead.
    throw deliberateServerError('That trail has no usable geometry.');
  }

  return {
    ...toSummary(row),
    description: row.description,
    geometry,
    profile: readProfile(row.profile?.points),
    waypoints: row.waypoints,
    surface: row.surface,
    sacScale: row.sacScale,
    dogsAllowed: row.dogsAllowed,
    wheelchairAccessible: row.wheelchairAccessible,
    feeRequired: row.feeRequired,
    // `node` exists in the enum for waypoints; a trail is only ever a way or a relation.
    osmType: row.osmType === 'relation' || row.osmType === 'way' ? row.osmType : null,
    // BigInt in the column because OSM ids passed 2^31 years ago. Number is exact well past
    // 2^53, and a BigInt would serialise to something neither client can read back.
    osmId: row.osmId === null ? null : Number(row.osmId),
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Filtering and ordering
// ---------------------------------------------------------------------------

/**
 * The viewport predicate: two boxes overlap unless one is entirely past an edge of the
 * other.
 *
 * A box that crosses the antimeridian (west > east) is split, because dragging the map
 * across the Pacific produces one and a naive `bboxW <= east` would then match the world.
 */
export function bboxOverlaps(bbox: BBox): Prisma.TrailWhereInput {
  const [w, s, e, n] = bbox;
  const vertical: Prisma.TrailWhereInput = { bboxS: { lte: n }, bboxN: { gte: s } };
  const horizontal = (west: number, east: number): Prisma.TrailWhereInput => ({
    bboxW: { lte: east },
    bboxE: { gte: west },
  });

  return w > e
    ? { AND: [vertical, { OR: [horizontal(w, 180), horizontal(-180, e)] }] }
    : { AND: [vertical, horizontal(w, e)] };
}

/**
 * Facets, as a single `where`.
 *
 * The tri-state OSM booleans (`dogsAllowed`, `wheelchairAccessible`) match the tagged value
 * exactly. Untagged is not the same as "no": a trail nobody has tagged for dogs is not a
 * trail that bans them, and folding null into false would hide most of the map from anyone
 * who ticks that box.
 */
export function facetWhere(input: Partial<TrailSearch>): Prisma.TrailWhereInput {
  const where: Prisma.TrailWhereInput = {};

  if (input.difficulty?.length) where.difficulty = { in: input.difficulty };
  if (input.routeType?.length) where.routeType = { in: input.routeType };
  if (input.activityTypes?.length) where.activityTypes = { hasSome: input.activityTypes };

  if (input.minLengthM !== undefined || input.maxLengthM !== undefined) {
    where.lengthM = { gte: input.minLengthM, lte: input.maxLengthM };
  }
  if (input.minGainM !== undefined || input.maxGainM !== undefined) {
    where.gainM = { gte: input.minGainM, lte: input.maxGainM };
  }
  if (input.minRating !== undefined) where.rating = { gte: input.minRating };
  if (input.dogsAllowed !== undefined) where.dogsAllowed = input.dogsAllowed;
  if (input.wheelchairAccessible !== undefined) {
    where.wheelchairAccessible = input.wheelchairAccessible;
  }

  return where;
}

/**
 * Sort order.
 *
 * Every ordering ends in `id` so pages neither overlap nor skip: without a unique
 * tiebreaker two trails with the same popularity can swap places between page 1 and page 2,
 * and the reader sees one of them twice and never sees the other.
 *
 * `relevance` and `distance_from_me` are absent because neither is expressible here — one
 * is ranked by the text query, the other by PostGIS. Both are re-applied in JS against the
 * id list those queries return.
 */
export function orderFor(sort: TrailSearch['sort']): Prisma.TrailOrderByWithRelationInput[] {
  switch (sort) {
    case 'rating':
      return [{ rating: { sort: 'desc', nulls: 'last' } }, { reviewCount: 'desc' }, { id: 'asc' }];
    case 'length_asc':
      return [{ lengthM: 'asc' }, { id: 'asc' }];
    case 'length_desc':
      return [{ lengthM: 'desc' }, { id: 'asc' }];
    case 'gain_asc':
      return [{ gainM: 'asc' }, { id: 'asc' }];
    case 'gain_desc':
      return [{ gainM: 'desc' }, { id: 'asc' }];
    default:
      return [{ popularity: 'desc' }, { rating: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }];
  }
}

/**
 * Text search: tsvector for meaning, trigram for typos.
 *
 * The two do different jobs and neither replaces the other. `websearch_to_tsquery` handles
 * stemming and phrases, so "waterfall hikes" finds "Waterfall Hike". Trigram similarity
 * handles the misspellings people actually type — "yosimite" matches nothing at all under a
 * tsquery. Ranking adds the two, so a trail satisfying both outranks one satisfying either.
 */
async function rankedTextIds(
  db: Context['db'],
  q: string,
  bbox: BBox | undefined,
): Promise<string[]> {
  // Inlined rather than reusing `bboxOverlaps`, which speaks Prisma. Antimeridian boxes are
  // not split here: they come from dragging a map, and a map drag calls `browse`.
  const box = bbox
    ? Prisma.sql`AND "bboxW" <= ${bbox[2]} AND "bboxE" >= ${bbox[0]}
                 AND "bboxS" <= ${bbox[3]} AND "bboxN" >= ${bbox[1]}`
    : Prisma.empty;

  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id
      FROM trails
     WHERE ("searchVector" @@ websearch_to_tsquery('english', ${q}) OR name % ${q})
       ${box}
     ORDER BY COALESCE(ts_rank("searchVector", websearch_to_tsquery('english', ${q})), 0)
                + similarity(name, ${q}) DESC,
              popularity DESC,
              id ASC
     LIMIT ${TEXT_CANDIDATE_CAP}
  `;
  return rows.map((row) => row.id);
}

/** Reorder rows to match an externally ranked id list, dropping whatever was filtered out. */
export function inRankOrder<T extends { id: string }>(
  rows: T[],
  rankedIds: readonly string[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  for (const id of rankedIds) {
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function toCoverage(result: CoverageResult): TileCoverage {
  return {
    readyTiles: result.ready,
    pendingTiles: result.pending,
    refreshingTiles: result.refreshing,
    tooLarge: result.tooLarge,
    requiredTiles: result.requiredTiles,
    maxTiles: result.maxTiles,
  };
}

/** Coverage for a query with no viewport: nothing to cover, so nothing is pending. */
function noCoverage(): CoverageResult {
  return {
    quadkeys: [],
    ready: [],
    pending: [],
    refreshing: [],
    queued: [],
    tooLarge: false,
    requiredTiles: 0,
    maxTiles: 0,
  };
}

/**
 * Work out what this viewport needs, but never fail the map over it.
 *
 * Coverage is bookkeeping about what we have *not* fetched yet. The trails already in
 * Postgres do not depend on it, and neither does drawing them — so an error here should cost
 * the reader the offer to fetch more, exactly as a failed area survey does, and nothing else.
 * It was instead taking the whole response with it: `ensureCoverage` opens with a read of
 * `ingest_tiles`, and when a drain had the background pool saturated that read was the first
 * thing to be refused, so `browse` threw, the client held no data, and the map sat on
 * "Fetching trails" over ground it had already ingested. That is the report this answers.
 *
 * Degrading to `noCoverage()` rather than to the tiles-are-pending shape is the deliberate
 * half. Reporting them pending would be more truthful and much worse: the client polls every
 * few seconds while anything is outstanding, so a database under enough load to fail this
 * call would get a poll storm on top, from every open map, for as long as it stayed down.
 * Claiming nothing is outstanding stops the polling, shows what we hold, and leaves the next
 * pan or zoom to ask the question again once there is a connection to answer it with.
 *
 * For the procedures that carry trails, then — `browse` and `search` — and deliberately not
 * for the `coverage` poll below, where coverage is not a side dish but the entire dish. A
 * swallowed error there would turn one transient refusal into a map that has permanently
 * stopped asking; letting it throw leaves the client's own retry to handle a blip, which is
 * what it is for.
 */
async function coverageFor(ctx: Context, bbox: BBox): Promise<CoverageResult> {
  try {
    return await ensureCoverage(bbox, { db: ctx.db });
  } catch (error) {
    console.warn('coverage failed', error);
    return noCoverage();
  }
}

function toArea(area: AreaCoverage): AreaSummary {
  return {
    tiles: area.quadkeys.length,
    fresh: area.fresh.length,
    outstanding: area.outstanding.length,
    working: area.working.length,
    requiredTiles: area.requiredTiles,
    capped: area.capped,
  };
}

/**
 * Survey the wider area, but only when the automatic path has given up on it.
 *
 * Folded into `browse` rather than given its own query, because it is needed at exactly the
 * moment `browse` is already running and the alternative is a second round trip on every
 * poll to answer a question that is usually "nothing to do". Two extra indexed reads over at
 * most ninety-six rows, and only past the twelve-tile ceiling — every ordinary zoom pays
 * nothing and gets `null`.
 */
async function surveyIfWide(ctx: Context, bbox: BBox, coverage: CoverageResult) {
  if (!coverage.tooLarge) return null;
  try {
    return toArea(await surveyArea(bbox, { db: ctx.db }));
  } catch (error) {
    // A failed survey must not take the map down with it. The trails in this response are
    // already fetched and correct; all that is lost is the offer to fetch more.
    console.warn('area survey failed', error);
    return null;
  }
}

/**
 * Whether an inline drain is already running in this process.
 *
 * A guard rather than a queue, and it is load-bearing. The client polls `browse` every few
 * seconds while a tile is outstanding, and `coverage.queued` reports every tile that still
 * needs work — not just the ones this call newly enqueued — so without this every poll
 * starts another drain. Those drains do not race for the same rows (`claimJobs` takes
 * `FOR UPDATE SKIP LOCKED`), which is exactly what makes the failure quiet: each new drain
 * politely claims *different* work and adds it to the pile. Forty seconds of polling a cold
 * viewport claims dozens of tiles, all of them queued behind an Overpass client capped at
 * two concurrent requests, and the one tile the user is actually waiting on is somewhere in
 * the middle of that queue. The map stays empty, every job says `running`, and nothing
 * anywhere reports an error.
 *
 * One drain at a time loses nothing. A drain already in flight will claim the newly queued
 * tile on its next iteration; a second drain would only claim it sooner in order to make it
 * wait the same amount of time behind the same rate limit.
 *
 * Module-level state, which is the right scope: it is guarding a process-level resource —
 * this process's Overpass concurrency — and on a serverless platform a process is one warm
 * instance. Instances do not need to coordinate, because the lock that keeps *them* from
 * duplicating work is in Postgres.
 */
let inlineDrain: Promise<unknown> | null = null;

/**
 * Start the queued work now, if the platform will let us.
 *
 * An optimisation over the cron, never a replacement for it: this runs the *same* drain the
 * cron runs, so a job it finishes is one the cron then finds already done, and a job it
 * drops to a timeout or a deploy is picked up a minute later. Errors are swallowed
 * deliberately — the response has already gone out, and an unhandled rejection in a
 * detached promise takes the process down on some runtimes. The reason is recorded on the
 * job row either way.
 *
 * Scoped to `coverage.queued` rather than left to claim the head of the table. Every
 * viewport tile carries the same priority, so an unscoped claim orders by `runAfter` and
 * takes the *oldest* pending tiles — which are, by construction, the ones nobody is looking
 * at any more. The work all gets done eventually either way; the difference is whether the
 * person waiting is the one it gets done for.
 */
function kickIngest(ctx: Context, queued: readonly string[]): void {
  if (!ctx.waitUntil || queued.length === 0 || inlineDrain) return;

  const work = drainIngest({
    limit: Math.min(queued.length, MAX_INLINE_DRAIN),
    workerId: 'inline',
    dedupeKeys: queued.map(tileJobKey),
  })
    .catch(() => {
      /* see ingest_jobs.lastError */
    })
    .finally(() => {
      inlineDrain = null;
    });

  inlineDrain = work;
  ctx.waitUntil(work);
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * Re-exported rather than moved out of sight: pagination is part of this router's contract,
 * and the reviews router pages the same way, so the implementation lives one level up where
 * both can reach it without either owning it.
 */
export { encodeCursor, decodeCursor } from '../cursor';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const browseInput = trailSearchSchema
  .omit({ cursor: true, near: true, radiusM: true, sort: true, limit: true })
  .extend({
    bbox: bboxSchema,
    /** Higher than search's, because these are map pins rather than cards. */
    limit: z.number().int().min(1).max(300).default(120),
    // The map has no notion of relevance or of where you are standing; both of those are
    // the search box's job. What is left is the orderings a plain `ORDER BY` can express.
    sort: z.enum(['popularity', 'rating', 'length_asc', 'length_desc']).default('popularity'),
  });

const trailIdInput = z.object({ trailId: z.string().min(1).max(64) });

export const trailsRouter = router({
  /**
   * Everything in the current viewport, with lines to draw.
   *
   * Deliberately not "all trails in the box" — it is "the `limit` most popular trails in
   * the box that match the filters", plus a total so the UI can say *showing 120 of 340,
   * zoom in for the rest*. Three hundred polylines take longer to reach a phone than the
   * Overpass call that produced them.
   */
  browse: publicProcedure.input(browseInput).query(async ({ ctx, input }) => {
    const coverage = await coverageFor(ctx, input.bbox);
    kickIngest(ctx, coverage.queued);
    const area = await surveyIfWide(ctx, input.bbox, coverage);

    /*
     * `tooLarge` bounds what we *fetch*, never what we *show*.
     *
     * These were one decision and should always have been two. The tile ceiling exists so a
     * viewport spanning a continent does not queue three hundred Overpass queries — that is
     * a real constraint and it stays. But it was also being used to return an empty result
     * set, which meant zooming out past twelve tiles emptied a map of ground we had already
     * ingested, cached, and could serve from an indexed query in milliseconds. The user's
     * report of it was exact: no map, cannot check places, cannot explore areas.
     *
     * Zoomed out is the view you use to decide where to go. Showing nothing there is a
     * strange answer for a trail finder, and "we have not fetched this" is not even true of
     * the ground it hides. So the query below runs at every zoom, bounded as it always was
     * by `input.limit` and the spatial index, and `tooLarge` is demoted to what it honestly
     * is: a note that coverage here is whatever we happen to hold, and zooming in is how you
     * ask for more.
     */

    /*
     * The search box narrows the map, not just the list.
     *
     * This used to be missing, and the failure was quiet in the worst way: `browseInput`
     * inherits `q` from `trailSearchSchema`, the client dutifully sent it on every
     * keystroke, and the where clause never mentioned it — so typing filtered nothing and
     * the total kept reporting every trail in the viewport. A search box that visibly
     * accepts text and changes no result reads as "no matches exist", which is a lie about
     * the data rather than a missing feature.
     *
     * Ranked ids rather than `name: { contains }` so the map agrees with the list: the same
     * tsvector-plus-trigram ranking `search` uses, scoped to the viewport it already
     * accepts. `rankedIds` is capped, so it is also what bounds the work here.
     */
    const rankedIds = input.q ? await rankedTextIds(ctx.db, input.q, input.bbox) : null;
    if (rankedIds !== null && rankedIds.length === 0) {
      return { trails: [], total: 0, coverage: toCoverage(coverage), area };
    }

    const where: Prisma.TrailWhereInput = {
      AND: [
        bboxOverlaps(input.bbox),
        facetWhere(input),
        ...(rankedIds === null ? [] : [{ id: { in: rankedIds } }]),
      ],
    };

    const [rows, total] = await Promise.all([
      ctx.db.trail.findMany({
        where,
        select: mapSelect,
        // Relevance is not expressible in `ORDER BY` here — it was computed by the ranking
        // query above — so a text search takes the whole candidate set and reorders it in
        // memory, exactly as `search` does. Without a query the plain ordering stands.
        ...(rankedIds === null ? { orderBy: orderFor(input.sort), take: input.limit } : {}),
      }),
      ctx.db.trail.count({ where }),
    ]);

    const ordered = rankedIds === null ? rows : inRankOrder(rows, rankedIds).slice(0, input.limit);
    const trails = ordered.map(toMapItem).filter((item): item is TrailMapItem => item !== null);
    return { trails, total, coverage: toCoverage(coverage), area };
  }),

  /**
   * Faceted search, with or without a map.
   *
   * Four inputs can each narrow the result and they compose: free text, a viewport, a
   * radius around a point, and the facets. Text and radius are ranked outside Prisma and
   * intersected here as id lists; everything else is a plain `where`.
   */
  search: publicProcedure.input(trailSearchSchema).query(async ({ ctx, input }) => {
    // Only a bbox describes an area to ingest. A text search with no map is answered from
    // what is already cached — the pipeline is tile-shaped, not query-shaped, so there is
    // no Overpass call that means "waterfall".
    const coverage = input.bbox ? await coverageFor(ctx, input.bbox) : noCoverage();
    if (input.bbox) kickIngest(ctx, coverage.queued);

    const empty = { trails: [], nextCursor: null, total: 0, coverage: toCoverage(coverage) };

    // No `tooLarge` gate here either — see `browse`. A search bounded by a wide box is the
    // most ordinary thing a user does ("waterfalls in Washington"), and answering it with
    // nothing because the box is wider than the ingest ceiling would be a search that gets
    // worse the more you tell it about where you want to go.

    const clauses: Prisma.TrailWhereInput[] = [facetWhere(input)];
    if (input.bbox) clauses.push(bboxOverlaps(input.bbox));

    // The two rankings Prisma cannot express, resolved to id lists and pushed into the
    // `where` — so the page and the total are computed over exactly the same set.
    let rankedIds: readonly string[] | null = null;

    if (input.q) {
      const textIds = await rankedTextIds(ctx.db, input.q, input.bbox);
      if (textIds.length === 0) return empty;
      clauses.push({ id: { in: [...textIds] } });
      rankedIds = textIds;
    }

    if (input.near) {
      const near = await trailIdsNear(
        ctx.db,
        input.near,
        input.radiusM ?? DEFAULT_RADIUS_M,
        NEAR_CANDIDATE_CAP,
      );
      if (near.length === 0) return empty;
      const nearIds = near.map((row) => row.id);
      clauses.push({ id: { in: nearIds } });
      // Proximity outranks text relevance only when the caller asked for it outright, or
      // when there is no text query for it to outrank.
      if (input.sort === 'distance_from_me' || !input.q) rankedIds = nearIds;
    }

    const where: Prisma.TrailWhereInput = { AND: clauses };
    const offset = decodeCursor(input.cursor);
    const externallyRanked = input.sort === 'relevance' || input.sort === 'distance_from_me';

    if (rankedIds !== null && externallyRanked) {
      // The candidate set is a few hundred ids at most, so reading it whole and paging in
      // memory costs one query and preserves the rank order exactly as computed.
      const rows = await ctx.db.trail.findMany({ where, select: summarySelect });
      const ordered = inRankOrder(rows, rankedIds);
      const page = ordered.slice(offset, offset + input.limit);
      const consumed = offset + page.length;
      return {
        trails: page.map(toSummary),
        nextCursor: consumed < ordered.length ? encodeCursor(consumed) : null,
        total: ordered.length,
        coverage: toCoverage(coverage),
      };
    }

    const [rows, total] = await Promise.all([
      ctx.db.trail.findMany({
        where,
        select: summarySelect,
        orderBy: orderFor(input.sort),
        skip: offset,
        take: input.limit,
      }),
      ctx.db.trail.count({ where }),
    ]);

    const consumed = offset + rows.length;
    return {
      trails: rows.map(toSummary),
      nextCursor: consumed < total ? encodeCursor(consumed) : null,
      total,
      coverage: toCoverage(coverage),
    };
  }),

  /** One trail, everything the detail page needs, in one round trip. */
  bySlug: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.trail.findUnique({
        where: { slug: input.slug },
        select: detailSelect,
      });
      if (!row) throw notFound();
      return toDetail(row);
    }),

  byId: publicProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.trail.findUnique({ where: { id: input.id }, select: detailSelect });
      if (!row) throw notFound();
      return toDetail(row);
    }),

  /**
   * The elevation profile on its own.
   *
   * Split from `bySlug` because it is the one part of a trail measured in thousands of
   * points, and because the weather and busyness features want it without the rest.
   */
  profile: publicProcedure.input(trailIdInput).query(async ({ ctx, input }) => {
    const row = await ctx.db.elevationProfile.findUnique({
      where: { trailId: input.trailId },
      select: { points: true, highPointIndex: true, spacingM: true },
    });
    if (!row) throw notFound('No elevation profile for that trail yet.');
    return {
      points: readProfile(row.points),
      highPointIndex: row.highPointIndex,
      spacingM: row.spacingM,
    };
  }),

  /**
   * The trail as GPX, for another map app.
   *
   * The trail itself — not somebody's recording of it, and not a route drawn over it. This
   * is the export people mean when they say they want to take a trail with them: the OSM
   * line, with our elevation under every point.
   *
   * Public and unauthenticated, like the trail page it sits on. The geometry is ODbL data we
   * are obliged to let people have; putting it behind an account would be worse than
   * pointless.
   */
  gpx: publicProcedure.input(trailIdInput).query(async ({ ctx, input }) => {
    const row = await loadForExport(ctx.db, input.trailId);
    return {
      filename: `${row.slug}.gpx`,
      xml: toRouteGpx(row.points, {
        name: row.name,
        description: row.description,
        activityType: row.activityType,
      }),
    };
  }),

  /**
   * The same trail as a FIT course, which is what a watch will actually take.
   *
   * The whole point of the pair. A Garmin will not navigate a GPX route without converting
   * it first, and the conversion drops the climb profile; the course file carries the ascent
   * graph, the summit marker and a virtual partner paced off our Tobler estimate, all from
   * numbers ingest already derived.
   *
   * Base64 for the reason it always is here: this is a JSON transport, `expo-file-system`
   * writes base64 directly, and the web costs one `atob`.
   */
  fit: publicProcedure.input(trailIdInput).query(async ({ ctx, input }) => {
    const row = await loadForExport(ctx.db, input.trailId);
    return {
      filename: `${row.slug}.fit`,
      base64: encodeBase64(
        toFitCourse(row.points, {
          name: row.name,
          activityType: row.activityType,
          // Stamped with the last time ingest reconciled this trail against OSM, not with
          // now. Two downloads of an unchanged trail then produce identical bytes, so a
          // watch treats the second as the course it already holds rather than stacking a
          // duplicate beside it — and when the line genuinely changes upstream the stamp
          // moves with it, so the device does see a new course. Both halves matter.
          createdAt: row.stampedAt,
          estimatedTimeS: row.estimatedTimeS,
        }),
      ),
    };
  }),

  /**
   * Photos for a trail, ours and scraped alike.
   *
   * Shaped by the photographs router so the gallery has one type to render whatever the
   * source is — including `isMine`, which is what puts a remove control under your own frame
   * and nothing under anybody else's.
   *
   * Ordered by source first, which puts user photographs ahead of the seeded ones: somebody
   * standing on the trail last week photographed what is there now, and Commons has whatever
   * was uploaded to a category in 2011. Within each, newest first.
   *
   * `license` and `attribution` travel with every row rather than being looked up per source:
   * Commons and Mapillary licences vary per image, and an unattributed CC-BY photo is a
   * licence breach, not a cosmetic gap.
   */
  photos: publicProcedure
    .input(trailIdInput.extend({ limit: z.number().int().min(1).max(60).default(24) }))
    .query(async ({ ctx, input }): Promise<TrailPhoto[]> => {
      const rows = await ctx.db.photo.findMany({
        where: { trailId: input.trailId },
        orderBy: [{ source: 'asc' }, { createdAt: 'desc' }],
        take: input.limit,
        select: photoSelect,
      });
      return rows.map((row) => toPhoto(row, ctx.user?.id ?? null));
    }),

  /** Trails within a radius of a point, nearest first. The "near me" list. */
  nearby: publicProcedure
    .input(
      z.object({
        at: lngLatSchema,
        radiusM: z.number().positive().max(200_000).default(DEFAULT_RADIUS_M),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const near = await trailIdsNear(ctx.db, input.at, input.radiusM, NEAR_CANDIDATE_CAP);
      if (near.length === 0) return [];

      const ids = near.slice(0, input.limit).map((row) => row.id);
      const rows = await ctx.db.trail.findMany({
        where: { id: { in: ids } },
        select: summarySelect,
      });
      const distances = new Map(near.map((row) => [row.id, row.distanceM]));

      return inRankOrder(rows, ids).map((row) => ({
        ...toSummary(row),
        distanceM: Math.round(distances.get(row.id) ?? 0),
      }));
    }),

  /**
   * Poll the ingest state for a viewport without fetching any trails.
   *
   * What the map calls on a timer while tiles are pending: an indexed read over at most
   * twelve rows, cheap enough to run every few seconds, so the client only re-runs the far
   * heavier `browse` once something has actually changed.
   */
  coverage: publicProcedure.input(z.object({ bbox: bboxSchema })).query(async ({ ctx, input }) => {
    // `urgent: false` — a poll must not re-prioritise work it is merely watching.
    const coverage = await ensureCoverage(input.bbox, { db: ctx.db, urgent: false });
    return toCoverage(coverage);
  }),

  /**
   * Fetch a whole area from OpenStreetMap, because somebody asked for it.
   *
   * The deliberate counterpart to the automatic ingest every viewport triggers. That path
   * refuses past twelve z9 tiles, and refusing is right when a map merely panned — nobody
   * asked to fetch a continent. But it left the zoomed-out view, which is the view you use
   * to decide where to go, with no way to say *yes, actually, fetch this*. This is that way.
   *
   * A mutation rather than a query despite reading like one, because it writes: rows appear
   * in `ingest_tiles` and `ingest_jobs`, and hiding that behind a GET is how you end up with
   * a browser prefetch or a React Strict Mode double-render queueing a hundred Overpass
   * calls. The client polls `browse` afterwards for progress; nothing here waits.
   *
   * Public, like the rest of the map. Requiring an account to look at trails would be a
   * different product, and the abuse surface is bounded four ways without one: the tile cap
   * per call, the freshness check that makes a repeat press free, the job dedupe that
   * collapses concurrent presses onto one row apiece, and the queue-depth guard that starts
   * refusing before anyone can bury the live viewports.
   */
  fetchArea: publicProcedure
    .input(z.object({ bbox: bboxSchema }))
    .mutation(async ({ ctx, input }) => {
      const area = await requestArea(input.bbox, { db: ctx.db });
      kickIngest(ctx, area.queued);
      return { ...toArea(area), queued: area.queued.length, busy: area.busy };
    }),
});

function notFound(message = 'No such trail.'): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message });
}
