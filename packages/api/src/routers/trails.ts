/**
 * Trails: browse, search, detail. Viewport procedures ask `ensureCoverage` (which queues what
 * is missing) then serve what Postgres already holds — they never wait on the fetch.
 * Lazy ingest and the indexed-bbox viewport predicate are in `docs/architecture.md`.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  bboxSchema,
  canModerate,
  lineStringSchema,
  lngLatSchema,
  trailSearchSchema,
} from '@switchback/core';
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
 * How many text-search candidates to rank before applying facets. Ranking must happen in one
 * raw query, so facets are applied afterwards in Prisma and anything past the cap is lost.
 */
const TEXT_CANDIDATE_CAP = 500;

/** Candidate cap for a radius search, before facets. */
const NEAR_CANDIDATE_CAP = 300;

/** Radius for "near me" when the client does not say. Roughly a half-hour drive. */
const DEFAULT_RADIUS_M = 30_000;

/** How many queued tiles one request will try to drain on its response's coattails. */
const MAX_INLINE_DRAIN = 4;

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
 * Read the stored line. Parsed rather than cast because the column is `Json`; a row that
 * fails is dropped from the response so one bad trail cannot blank the map.
 */
function readGeometry(value: Prisma.JsonValue): LineString | null {
  const parsed = lineStringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Everything both export procedures need, so GPX and FIT cannot disagree about what "the
 * trail" is. Returns the 25 m elevation profile where there is one, falling back to the
 * rendered line at zero elevation — a device handed a line with no ground under it invents
 * the ascent from whatever DEM it ships with.
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
    // A file carries one sport; ingest orders `activityTypes` with the primary use first.
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
    // Ingest writes geometry and stats in one transaction, so this is a corrupted row, not
    // an unenriched one. Marked so the message survives serialisation, and a 500 rather than
    // `NOT_FOUND` because the latter renders as a 404 page.
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
    // BigInt in the column because OSM ids passed 2^31 years ago; a BigInt would serialise
    // to something neither client can read back, and Number is exact well past 2^53.
    osmId: row.osmId === null ? null : Number(row.osmId),
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
  };
}

/**
 * The viewport predicate: two boxes overlap unless one is entirely past an edge of the other.
 * A box crossing the antimeridian (west > east) is split, or a naive `bboxW <= east` matches
 * the whole world.
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
 * Facets, as a single `where`. The tri-state OSM booleans match the tagged value exactly:
 * untagged is not "no", and folding null into false would hide most of the map.
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
 * Sort order. Every ordering must end in `id` — without a unique tiebreaker two equally
 * ranked trails swap between pages, so one is seen twice and the other never. `relevance`
 * and `distance_from_me` are absent: both are re-applied in JS against a ranked id list.
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
 * Text search: tsvector for meaning, trigram for typos. Neither replaces the other —
 * `websearch_to_tsquery` stems and handles phrases, similarity catches "yosimite", which
 * matches nothing under a tsquery. Ranks are summed so a trail satisfying both wins.
 *
 * Both names are searched. The tsvector already carries `displayName` (see
 * `refreshTrailSearchVector`), so the trigram half has to as well or "Vesper Pk" reaches a
 * trail that "Vesper Peak" does. `GREATEST` rather than a sum: a trail whose two names both
 * resemble the query is not twice as relevant as one that matches on the title alone.
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
     WHERE ("searchVector" @@ websearch_to_tsquery('english', ${q})
            OR name % ${q}
            OR "displayName" % ${q})
       ${box}
     ORDER BY COALESCE(ts_rank("searchVector", websearch_to_tsquery('english', ${q})), 0)
                + GREATEST(similarity(name, ${q}),
                           similarity(COALESCE("displayName", ''), ${q})) DESC,
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

function toCoverage(result: CoverageResult): TileCoverage {
  return {
    readyTiles: result.ready,
    pendingTiles: result.pending,
    refreshingTiles: result.refreshing,
    tooLarge: result.tooLarge,
    busy: result.busy,
    busyReason: result.busyReason,
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
    busy: false,
    busyReason: null,
    tooLarge: false,
    requiredTiles: 0,
    maxTiles: 0,
  };
}

/**
 * Coverage for a viewport, degraded rather than thrown: the trails already in Postgres do
 * not depend on it, so a failure costs only the offer to fetch more.
 *
 * Degrading to `noCoverage()` and not to the tiles-are-pending shape is deliberate — the
 * client polls while anything is outstanding, so reporting pending would add a poll storm
 * from every open map to a database already failing. Used only by the procedures that carry
 * trails; the `coverage` poll below lets the error through, because swallowing it there
 * would leave a client that has permanently stopped asking.
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
 * Survey the wider area, but only past the tile ceiling — every ordinary zoom pays nothing
 * and gets `null`. Folded into `browse` rather than given its own query so a poll does not
 * cost a second round trip to answer "nothing to do".
 */
async function surveyIfWide(ctx: Context, bbox: BBox, coverage: CoverageResult) {
  if (!coverage.tooLarge) return null;
  try {
    return toArea(await surveyArea(bbox, { db: ctx.db }));
  } catch (error) {
    // All that is lost is the offer to fetch more; the trails in this response are correct.
    console.warn('area survey failed', error);
    return null;
  }
}

/**
 * Whether an inline drain is already running in this process. Load-bearing: `coverage.queued`
 * reports every outstanding tile, not just newly enqueued ones, so without this every poll
 * starts another drain. They do not race (`claimJobs` uses `FOR UPDATE SKIP LOCKED`) — they
 * pile more claimed work behind an Overpass client capped at two concurrent requests, so the
 * tile the reader is waiting on sinks down the queue with nothing reporting an error.
 *
 * Module state is the right scope: it guards this process's Overpass concurrency, and what
 * keeps separate instances from duplicating work is the lock in Postgres.
 */
let inlineDrain: Promise<unknown> | null = null;

/**
 * Start the queued work now, if the platform will let us. An optimisation over the cron,
 * never a replacement: it runs the same idempotent drain, so anything it drops to a timeout
 * or a deploy is picked up a minute later. Errors are swallowed because the response has
 * already gone out and the reason is on the job row.
 *
 * Scoped to `coverage.queued` rather than claiming the head of the table: viewport tiles all
 * carry the same priority, so an unscoped claim orders by `runAfter` and takes the oldest
 * pending tiles — the ones nobody is looking at any more. That scoping is also why
 * `drainIngest` reserves a derived share on top; a tile-key list cannot reach an
 * `enrich_trail` row, so the fan-out these tiles produce had no drainer in the request path
 * at all. See `drainJobs` and `DERIVED_QUEUE_WARN_DEPTH`.
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

/** Pagination lives one level up so the reviews router can page the same way. */
export { encodeCursor, decodeCursor } from '../cursor';

const browseInput = trailSearchSchema
  .omit({ cursor: true, near: true, radiusM: true, sort: true, limit: true })
  .extend({
    bbox: bboxSchema,
    /** Higher than search's, because these are map pins rather than cards. */
    limit: z.number().int().min(1).max(300).default(120),
    // Relevance and proximity are the search box's job; what is left is what a plain
    // `ORDER BY` can express.
    sort: z.enum(['popularity', 'rating', 'length_asc', 'length_desc']).default('popularity'),
  });

const trailIdInput = z.object({ trailId: z.string().min(1).max(64) });

export const trailsRouter = router({
  /**
   * The `limit` most popular trails in the box that match the filters, with lines to draw,
   * plus a total so the UI can offer "showing 120 of 340". Three hundred polylines take
   * longer to reach a phone than the Overpass call that produced them.
   */
  browse: publicProcedure.input(browseInput).query(async ({ ctx, input }) => {
    const coverage = await coverageFor(ctx, input.bbox);
    kickIngest(ctx, coverage.queued);
    const area = await surveyIfWide(ctx, input.bbox, coverage);

    /*
     * `tooLarge` bounds what we fetch, never what we show: the query below runs at every
     * zoom, bounded by `input.limit` and the spatial index. Gating results on it emptied the
     * map of ground already ingested, which is the view a reader uses to decide where to go.
     *
     * `q` narrows the map as well as the list. `browseInput` inherits it from
     * `trailSearchSchema` and the client sends it on every keystroke, so leaving it out of
     * the where clause reads as "no matches exist". Ranked ids rather than
     * `name: { contains }`, so the map agrees with `search`; `rankedIds` is capped, which is
     * also what bounds the work here.
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
        // Relevance is not expressible in `ORDER BY` — it was computed by the ranking query
        // above — so a text search reorders the whole candidate set in memory.
        ...(rankedIds === null ? { orderBy: orderFor(input.sort), take: input.limit } : {}),
      }),
      ctx.db.trail.count({ where }),
    ]);

    const ordered = rankedIds === null ? rows : inRankOrder(rows, rankedIds).slice(0, input.limit);
    const trails = ordered.map(toMapItem).filter((item): item is TrailMapItem => item !== null);
    return { trails, total, coverage: toCoverage(coverage), area };
  }),

  /**
   * Faceted search, with or without a map. Free text, a viewport, a radius and the facets all
   * compose; text and radius are ranked outside Prisma and intersected here as id lists.
   */
  search: publicProcedure.input(trailSearchSchema).query(async ({ ctx, input }) => {
    // Only a bbox describes an area to ingest — the pipeline is tile-shaped, not
    // query-shaped, so there is no Overpass call that means "waterfall".
    const coverage = input.bbox ? await coverageFor(ctx, input.bbox) : noCoverage();
    if (input.bbox) kickIngest(ctx, coverage.queued);

    const empty = { trails: [], nextCursor: null, total: 0, coverage: toCoverage(coverage) };

    // No `tooLarge` gate here either — see `browse`.

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
      // Proximity outranks text relevance only when asked for outright, or when there is no
      // text query for it to outrank.
      if (input.sort === 'distance_from_me' || !input.q) rankedIds = nearIds;
    }

    const where: Prisma.TrailWhereInput = { AND: clauses };
    const offset = decodeCursor(input.cursor);
    const externallyRanked = input.sort === 'relevance' || input.sort === 'distance_from_me';

    if (rankedIds !== null && externallyRanked) {
      // A few hundred ids at most, so reading the set whole and paging in memory costs one
      // query and preserves the rank order exactly as computed.
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
   * The elevation profile on its own — thousands of points, and the weather and busyness
   * features want it without the rest of the trail.
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
   * The OSM line with our elevation under every point, as GPX. Public and unauthenticated
   * like the trail page: the geometry is ODbL data we are obliged to let people have.
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
   * The same trail as a FIT course, which is what a watch will actually take: a Garmin
   * converts a GPX route before navigating it and drops the climb profile, where the course
   * file carries the ascent graph, summit marker and a Tobler-paced virtual partner.
   * Base64 because this is a JSON transport and `expo-file-system` writes base64 directly.
   */
  fit: publicProcedure.input(trailIdInput).query(async ({ ctx, input }) => {
    const row = await loadForExport(ctx.db, input.trailId);
    return {
      filename: `${row.slug}.fit`,
      base64: encodeBase64(
        toFitCourse(row.points, {
          name: row.name,
          activityType: row.activityType,
          // Stamped with the trail's own `sourceUpdatedAt`, not the clock: two downloads of
          // an unchanged trail must produce identical bytes so a watch treats the second as
          // the course it already holds, and the stamp must still move when OSM changes.
          createdAt: row.stampedAt,
          estimatedTimeS: row.estimatedTimeS,
        }),
      ),
    };
  }),

  /**
   * Photos for a trail, ours and scraped alike, shaped by the photographs router so the
   * gallery has one type whatever the source is. Ordered by source first, which puts user
   * photographs ahead of the seeded ones; `license` and `attribution` travel with every row
   * because Commons and Mapillary licences vary per image.
   *
   * `includeHidden` is honoured for operators and ignored for everybody else. The strip is
   * where the only `unhide` control lives, so filtering hidden frames out of it for a
   * moderator would make a takedown irreversible from the product. `toPhoto` has already
   * blanked the URL on a hidden row, so what comes back is the fact, not the image.
   */
  photos: publicProcedure
    .input(
      trailIdInput.extend({
        limit: z.number().int().min(1).max(60).default(24),
        includeHidden: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }): Promise<TrailPhoto[]> => {
      const operator = input.includeHidden && canModerate(ctx.user?.role);

      const rows = await ctx.db.photo.findMany({
        // No tombstone for the reader: a grey box tells them nothing and tells whoever
        // reported it that we did not act. The uploader is told, on `photos.mine`.
        where: { trailId: input.trailId, ...(operator ? {} : { hiddenAt: null }) },
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
   * Poll the ingest state for a viewport without fetching any trails: an indexed read over at
   * most twelve rows, so the client only re-runs the far heavier `browse` once something has
   * changed.
   */
  coverage: publicProcedure.input(z.object({ bbox: bboxSchema })).query(async ({ ctx, input }) => {
    // `urgent: false` — a poll must not re-prioritise work it is merely watching.
    const coverage = await ensureCoverage(input.bbox, { db: ctx.db, urgent: false });
    return toCoverage(coverage);
  }),

  /**
   * Fetch a whole area from OSM because somebody asked for it — the counterpart to the
   * automatic ingest, which refuses past twelve z9 tiles and so leaves the zoomed-out view no
   * way to say "yes, actually, fetch this".
   *
   * A mutation despite reading like one, because it writes: behind a GET, a browser prefetch
   * or a Strict Mode double-render would queue a hundred Overpass calls. Public, like the
   * rest of the map; the abuse surface is bounded by the per-call tile cap, the freshness
   * check, the job dedupe and the queue-depth guard.
   */
  fetchArea: publicProcedure
    .input(z.object({ bbox: bboxSchema }))
    .mutation(async ({ ctx, input }) => {
      const area = await requestArea(input.bbox, { db: ctx.db });
      kickIngest(ctx, area.queued);
      // `busyReason` rides along with `busy`: the refusal copy has to tell a deep queue,
      // which clears, apart from a full database, which does not.
      return {
        ...toArea(area),
        queued: area.queued.length,
        busy: area.busy,
        busyReason: area.busyReason,
      };
    }),
});

function notFound(message = 'No such trail.'): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message });
}
