/**
 * From assembled geometry and OSM tags to the columns a `Trail` row actually stores.
 *
 * Every function here is pure and synchronous. That is deliberate: this is the step whose
 * output users read as fact — "1,325 m of gain", "hard", "6h 40m" — so it has to be
 * testable without a network, and every judgement call in it has to be visible rather
 * than buried in the pipeline.
 *
 * The OSM tag readings are the fiddly part. Tags are free text maintained by hundreds of
 * thousands of people, so `dog=leashed`, `dog=yes`, and `dog=leashed_only` all mean the
 * same thing to a hiker, and code that only matches `yes` quietly tells people their dog
 * is banned.
 */

import type {
  ActivityType,
  BBox,
  Difficulty,
  ElevationPoint,
  LngLat,
  RouteType,
  SacScale,
  TrailStats,
} from '@switchback/core';
import { SAC_SCALES, classifyDifficulty } from '@switchback/core';
import type { TerminusKinds } from '@switchback/geo';
import {
  classifyRouteType,
  climbsToADeadEnd,
  computeTrailStats,
  hasImpliedReturnLeg,
  highPointIndex,
  isTraverse,
  mirrorProfile,
  namesACircuit,
  namesAThoroughfare,
  terrainFactorFor,
} from '@switchback/geo';

export interface DerivedTrail {
  stats: TrailStats;
  difficulty: Difficulty;
  difficultyScore: number;
  routeType: RouteType;
  activityTypes: ActivityType[];
  highPointIndex: number;
  surface: string | null;
  sacScale: SacScale | null;
  dogsAllowed: boolean | null;
  wheelchairAccessible: boolean | null;
  feeRequired: boolean | null;
  centroid: LngLat;
  bbox: BBox;
  description: string | null;
  /**
   * The geometry and profile in hiking order, which is not always the order OSM stored
   * them in. Callers must persist these rather than their own inputs — see `orientUphill`.
   */
  coords: readonly LngLat[];
  profile: readonly ElevationPoint[];
  /** True when the OSM line ran downhill and we flipped it. Recorded for the ingest log. */
  reversed: boolean;
}

/**
 * `sac_scale` is the one OSM difficulty tag with a published definition, and where it
 * exists it beats anything we could infer from gain and length. Anything outside the
 * scale is a typo or a local dialect, and guessing at it is worse than ignoring it.
 */
export function parseSacScale(value: string | undefined): SacScale | null {
  if (!value) return null;
  const normalised = value.trim().toLowerCase().replace(/\s+/g, '_');
  return (SAC_SCALES as readonly string[]).includes(normalised) ? (normalised as SacScale) : null;
}

/**
 * Tri-state, and the `null` is the point. "Nobody has tagged this" and "dogs are banned"
 * are different facts, and showing the second when you mean the first is how a product
 * loses someone's trust on the one thing they checked before driving two hours.
 */
export function parseTriState(value: string | undefined): boolean | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (['yes', 'designated', 'permissive', 'official', 'leashed', 'leashed_only'].includes(v)) {
    return true;
  }
  if (['no', 'private', 'prohibited', 'restricted'].includes(v)) return false;
  return null;
}

/** `fee=yes|no`, but also the older `charge=*`, which implies a fee by existing. */
export function parseFee(tags: Record<string, string>): boolean | null {
  const fee = parseTriState(tags.fee);
  if (fee !== null) return fee;
  return tags.charge ? true : null;
}

/**
 * What you can actually do on this trail.
 *
 * Hiking is the floor for anything that reached assembly — a named path is walkable by
 * definition — and everything else is added on positive evidence. `sac_scale` above T3 is
 * the exception that *removes* things: a route needing hands is not a trail run, and
 * listing it as one is the kind of quiet error that gets somebody hurt.
 */
export function deriveActivityTypes(
  tags: Record<string, string>,
  sacScale: SacScale | null,
): ActivityType[] {
  const types = new Set<ActivityType>(['hiking']);
  const route = tags.route ?? '';
  const highway = tags.highway ?? '';

  const technical =
    sacScale !== null &&
    [
      'demanding_mountain_hiking',
      'alpine_hiking',
      'demanding_alpine_hiking',
      'difficult_alpine_hiking',
    ].includes(sacScale);

  if (!technical) {
    types.add('trail_running');
  } else {
    types.add('scrambling');
  }

  if (
    tags['mtb:scale'] !== undefined ||
    parseTriState(tags.bicycle) === true ||
    highway === 'cycleway'
  ) {
    types.add('mountain_biking');
  }
  if (parseTriState(tags.horse) === true || highway === 'bridleway') {
    types.add('horseback_riding');
  }
  // Long-distance networks — international, national, regional — are the ones people
  // take multiple days over. A local hiking network (`lwn`) is an afternoon.
  const network = tags.network ?? '';
  if (route === 'hiking' && /^(iwn|nwn|rwn)$/.test(network)) {
    types.add('backpacking');
  }
  if (tags.via_ferrata_scale !== undefined || highway === 'via_ferrata') {
    types.add('via_ferrata');
  }
  if (tags.piste_type !== undefined) types.add('skiing');

  return [...types];
}

/**
 * `description` on a relation is usually a sentence somebody wrote about the route, and
 * it is the only prose OSM gives us. `note` is excluded on purpose — it is mapper-facing
 * ("check this junction, survey 2019"), not hiker-facing.
 */
export function deriveDescription(tags: Record<string, string>): string | null {
  const candidate = tags.description ?? tags['description:en'] ?? null;
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return trimmed.length >= 20 ? trimmed : null;
}

/** Midpoint by distance along the line, not the bbox centre — which for a horseshoe-shaped trail sits off the trail entirely, in the valley. */
export function centroidOf(profile: readonly ElevationPoint[], coords: readonly LngLat[]): LngLat {
  if (profile.length === 0) {
    const mid = coords[Math.floor(coords.length / 2)];
    return mid ?? [0, 0];
  }
  const halfway = profile[profile.length - 1]!.distM / 2;
  let best = profile[0]!;
  for (const point of profile) {
    if (point.distM <= halfway) best = point;
    else break;
  }
  return [best.lng, best.lat];
}

export interface DeriveInput {
  coords: readonly LngLat[];
  profile: readonly ElevationPoint[];
  bbox: BBox;
  tags: Record<string, string>;
  /**
   * What OSM has mapped at each end of the line, from `terminusFeatures`. Optional: a trail
   * ingested before the feature query ran, or in an area with nothing tagged at either end,
   * simply falls back to geometry and the `roundtrip` tag.
   */
  termini?: TerminusKinds;
}

/**
 * Net elevation change below which we leave the line alone.
 *
 * Terrarium samples carry a few metres of noise, and a genuinely flat traverse can end a
 * metre or two either side of where it started. Flipping on that would be arbitrary — the
 * same trail could face either way depending on which DEM tile it landed on. Twenty metres
 * is comfortably above the noise and far below any climb a hiker would call a climb.
 */
const ORIENT_THRESHOLD_M = 20;

/**
 * Put the line in hiking order.
 *
 * **The bug this fixes.** A way's direction in OSM is whatever the mapper happened to draw,
 * and for a mountain path that is a coin flip. Snowdon's Watkin Path came out of Overpass
 * summit-first, so the honest arithmetic over the stored line gave `gainM: 22, lossM: 942`
 * — correct for the direction the geometry ran, and a flat lie about the hike. Nobody hikes
 * the Watkin Path downhill. The same tile had Llanberis Path stored trailhead-first and
 * therefore right, which is what makes this class of bug so easy to miss: it is wrong on
 * roughly half the trails, and the other half look fine.
 *
 * So the fix cannot be a display-time `Math.max(gain, loss)`. Gain and loss are genuinely
 * different numbers on a point-to-point route, the elevation profile has to rise left to
 * right to match, the waypoints have to measure from the trailhead rather than the summit,
 * and the Tobler estimate has to price the climb as a climb. All of those follow from the
 * array order, so the array is what we fix, once, here — before anything reads it.
 *
 * **Why comparing the endpoints is enough.** A loop and a retracing out-and-back both end
 * where they started, so their net is ~0 and neither is touched, which is right: their gain
 * and loss are equal by construction and the start point is the mapper's choice either way.
 * The only shape with a meaningful net is point-to-point, which is exactly the one where
 * hikers have a convention — you hike up — and where getting it backwards is visible.
 */
export function orientUphill(
  coords: readonly LngLat[],
  profile: readonly ElevationPoint[],
): { coords: readonly LngLat[]; profile: readonly ElevationPoint[]; reversed: boolean } {
  const first = profile[0];
  const last = profile[profile.length - 1];
  if (!first || !last || first.eleM - last.eleM <= ORIENT_THRESHOLD_M) {
    return { coords, profile, reversed: false };
  }

  return {
    coords: [...coords].reverse(),
    profile: reverseProfile(profile, last.distM),
    reversed: true,
  };
}

/**
 * The same samples hiked the other way: reversed, with `distM` re-measured from the new
 * start so it still runs 0 → length. Leaving the old distances attached would put the
 * trailhead at 5,640 m and break every chart and waypoint that reads them.
 */
function reverseProfile(profile: readonly ElevationPoint[], totalM: number): ElevationPoint[] {
  return (
    profile
      // Rounded because subtracting floats reintroduces the 24.999999999 that `resampleLine`
      // was careful to avoid, and these distances are read back as chart axis labels.
      .map((point) => ({ ...point, distM: Math.round((totalM - point.distM) * 10) / 10 }))
      .reverse()
  );
}

export function deriveTrail(input: DeriveInput): DerivedTrail {
  const { bbox, tags } = input;

  const sacScale = parseSacScale(tags.sac_scale);
  const surface = tags.surface?.trim() || null;

  // Before anything reads the arrays. Route type, bbox, and the tag readings are all
  // invariant under reversal; the stats, the profile, and the waypoint distances are not.
  const { coords, profile, reversed } = orientUphill(input.coords, input.profile);

  const geometryType = classifyRouteType(coords);

  /**
   * Two ways a line can be one leg of a two-leg hike, and both have to be asked.
   *
   * `roundtrip=yes` says the hike returns to where it started. It does not say the geometry
   * contains the return leg — and usually it does not, because mappers draw the path once.
   * It is the authority when present, and it is present on maybe one route relation in fifty.
   *
   * `hasImpliedReturnLeg` is the fallback that covers the rest: a short line with a summit,
   * viewpoint, waterfall or lake at exactly one end is a spur, hiked out and back, whatever
   * its endpoints say. See `packages/geo/src/route-type.ts` for why that rule is shaped the
   * way it is and what it deliberately refuses to guess at.
   *
   * `climbsToADeadEnd` catches the case that has nothing tagged at all — a line that climbs
   * 400 m and whose highest sample is its last. Snowdon's Pyg Track stops at the ridge
   * junction, too far from the summit node for the terminus test, and is caught here. Two
   * things veto it, both scoped to it alone because it is the one rule reading nothing but the
   * shape of the ground: `isTraverse`, because a ridge hike finishing on the higher of its two
   * summits satisfies "ends at its high point" trivially and what OSM tagged at both ends beats
   * what the shape merely suggests; and `namesAThoroughfare`, because a *chemin* is a farm lane
   * that climbs to an alp and carries on, however steeply it climbs to get there.
   *
   * `namesACircuit` vetoes all of them. A trail the mapper called a loop, drawn as a line that
   * does not close, is missing the other half of a circle — not a return along the same
   * ground — and mirroring it would fabricate an elevation profile.
   *
   * `classifyRouteType` only reports `out_and_back` when the line demonstrably retraces
   * itself, so the signals together tell us which case we are in:
   *
   * - retracing geometry → both legs are drawn, and the profile already covers the hike.
   * - a one-way line that neither retraces nor closes, plus any signal above → one leg
   *   drawn, the return implied, so the stats must account for hiking it back.
   *
   * Getting this backwards would publish a 5 km hike as 10 km, which is the most visible
   * way this pipeline could lie to somebody.
   */
  const taggedRoundTrip = /^(yes|true)$/i.test(tags.roundtrip?.trim() ?? '');
  const termini = input.termini;
  const first = profile[0];
  const last = profile[profile.length - 1];
  const oneWayLengthM = last?.distM ?? 0;
  const topIndex = highPointIndex(profile);
  const impliedReturn =
    geometryType === 'point_to_point' &&
    !namesACircuit(tags.name) &&
    (taggedRoundTrip ||
      (termini ? hasImpliedReturnLeg(termini, oneWayLengthM) : false) ||
      ((termini ? !isTraverse(termini) : true) &&
        !namesAThoroughfare(tags.name) &&
        climbsToADeadEnd({
          netGainM: first && last ? last.eleM - first.eleM : 0,
          dropFromTopM: last ? (profile[topIndex]?.eleM ?? last.eleM) - last.eleM : Number.NaN,
          lengthM: oneWayLengthM,
        })));
  const routeType: RouteType = impliedReturn ? 'out_and_back' : geometryType;

  /**
   * Gated on `impliedReturn`, not on `routeType === 'out_and_back'`, and the difference
   * matters downstream. A trail classified out-and-back by `classifyRouteType` was
   * classified *from* its retracing, so both legs are already in `profile` and mirroring
   * would double a hike that is already whole. Only the implied kind is half a hike here.
   *
   * That distinction is not recoverable from the stored row, which is why anything drawing
   * this profile later has to rediscover it by comparing the geometry against `lengthM` —
   * see `hikedProfile`.
   */
  const statsProfile = impliedReturn ? mirrorProfile(profile) : profile;

  const stats = computeTrailStats(statsProfile, {
    terrainFactor: terrainFactorFor({ sacScale, surface }),
  });

  const difficulty = classifyDifficulty({
    gainM: stats.gainM,
    lengthM: stats.lengthM,
    sacScale: sacScale ?? undefined,
    maxSustainedGrade: stats.maxSustainedGrade ?? undefined,
  });

  return {
    stats,
    difficulty: difficulty.difficulty,
    difficultyScore: difficulty.score,
    routeType,
    activityTypes: deriveActivityTypes(tags, sacScale),
    // Indexes into the *stored* profile, which is the geometry we actually have, not the
    // mirrored one used for the arithmetic.
    highPointIndex: topIndex,
    surface,
    sacScale,
    dogsAllowed: parseTriState(tags.dog),
    wheelchairAccessible: parseTriState(tags.wheelchair),
    feeRequired: parseFee(tags),
    centroid: centroidOf(profile, coords),
    bbox,
    description: deriveDescription(tags),
    coords,
    profile,
    reversed,
  };
}

/**
 * URL slug.
 *
 * Region-qualified because trail names are not unique — every mountainous country has a
 * "Summit Trail" — and a slug collision would otherwise be resolved by a numeric suffix,
 * which tells a reader nothing. The caller adds a suffix only when the qualified form
 * still collides.
 */
export function slugify(name: string, region?: string | null): string {
  const parts = [name, region].filter(Boolean).join(' ');
  const slug = parts
    .normalize('NFKD')
    // Strip the diacritic marks NFKD just separated out, so "Åreskutan" slugs as
    // "areskutan" rather than losing the vowel entirely.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'trail';
}

/**
 * The tsvector input, weighted by field.
 *
 * Postgres `setweight` ranks A above B above C, so a search for "nevis" puts the trail
 * named Ben Nevis above one merely described as being near it. Built here rather than in
 * a trigger because `prisma db push` and triggers fight over ownership of the column.
 */
export function searchDocument(input: {
  name: string;
  regionName: string | null;
  description: string | null;
}): { a: string; b: string; c: string } {
  return {
    a: input.name,
    b: input.regionName ?? '',
    c: (input.description ?? '').slice(0, 2000),
  };
}
