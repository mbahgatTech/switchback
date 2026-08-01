/**
 * From assembled geometry and OSM tags to the columns a `Trail` row stores. Pure and
 * synchronous throughout: this is the step whose output readers take as fact.
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
 * `sac_scale` is the one OSM difficulty tag with a published definition, and where it exists
 * it beats anything inferred from gain and length. Values outside the scale are ignored.
 */
export function parseSacScale(value: string | undefined): SacScale | null {
  if (!value) return null;
  const normalised = value.trim().toLowerCase().replace(/\s+/g, '_');
  return (SAC_SCALES as readonly string[]).includes(normalised) ? (normalised as SacScale) : null;
}

/**
 * Tri-state, and the `null` is the point: "nobody has tagged this" and "dogs are banned" are
 * different facts. The synonym lists matter — `dog=leashed` and `dog=leashed_only` both mean
 * yes, and matching only `yes` tells people their dog is banned.
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
 * What you can do on this trail. Hiking is the floor — a named path is walkable by definition
 * — and everything else needs positive evidence. `sac_scale` above T3 is the exception that
 * *removes* things: a route needing hands is not a trail run.
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
  // Long-distance networks — international, national, regional — are the ones people take
  // multiple days over. A local hiking network (`lwn`) is an afternoon.
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
 * `description` is the only prose OSM gives us. `note` is excluded on purpose — it is
 * mapper-facing ("check this junction, survey 2019"), not hiker-facing.
 */
export function deriveDescription(tags: Record<string, string>): string | null {
  const candidate = tags.description ?? tags['description:en'] ?? null;
  if (!candidate) return null;
  const trimmed = candidate.trim();
  return trimmed.length >= 20 ? trimmed : null;
}

/** Midpoint by distance along the line: a horseshoe trail's bbox centre is in the valley. */
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
   * What OSM has mapped at each end of the line, from `terminusFeatures`. Optional: without
   * it the classifier falls back to geometry and the `roundtrip` tag.
   */
  termini?: TerminusKinds;
}

/**
 * Net elevation change below which the line is left alone. Terrarium samples carry a few
 * metres of noise, so a flat traverse could otherwise face either way depending on which DEM
 * tile it landed on. Twenty metres is above the noise and below any climb worth the name.
 */
const ORIENT_THRESHOLD_M = 20;

/**
 * Put the line in hiking order. A way's direction in OSM is whatever the mapper drew, and for
 * a mountain path that is a coin flip — Snowdon's Watkin Path arrives summit-first and gives
 * `gainM: 22, lossM: 942`, correct for the geometry and a flat lie about the hike.
 *
 * The fix cannot be a display-time `Math.max(gain, loss)`: the profile has to rise left to
 * right, the waypoints have to measure from the trailhead, and Tobler has to price the climb
 * as a climb. All of that follows from array order, so the array is what is fixed, once, here.
 *
 * Comparing the endpoints is enough because a loop and a retracing out-and-back both net ~0
 * and are left alone, which is right — their start point is the mapper's choice either way.
 * Point-to-point is the only shape with a convention (you hike up) and a visible error.
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
 * The same samples hiked the other way, with `distM` re-measured from the new start so it
 * still runs 0 to length. Leaving the old distances attached puts the trailhead at 5,640 m.
 */
function reverseProfile(profile: readonly ElevationPoint[], totalM: number): ElevationPoint[] {
  return (
    profile
      // Rounded because subtracting floats reintroduces the 24.999999999 that `resampleLine`
      // avoided, and these distances are read back as chart axis labels.
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
   * Four signals that a drawn line is one leg of a two-leg hike, and all have to be asked.
   *
   * `roundtrip=yes` is the authority when present, on maybe one relation in fifty. It says the
   * hike returns to its start, not that the geometry contains the return leg.
   * `hasImpliedReturnLeg` covers the rest: a short line with a destination at exactly one end.
   * `climbsToADeadEnd` catches lines with nothing tagged at all — Snowdon's Pyg Track stops at
   * the ridge junction, too far from the summit node for the terminus test. Two things veto
   * that one alone, since it reads nothing but the shape of the ground: `isTraverse`, which a
   * ridge hike finishing on the higher of two summits satisfies trivially, and
   * `namesAThoroughfare`, because a *chemin* climbs to an alp and carries on.
   *
   * `namesACircuit` vetoes all of them: a line the mapper called a loop is missing the other
   * half of a circle, not a return along the same ground, and mirroring it fabricates a profile.
   *
   * `classifyRouteType` reports `out_and_back` only when the line demonstrably retraces itself,
   * so retracing geometry means both legs are already drawn. Getting this backwards publishes a
   * 5 km hike as 10 km. See `packages/geo/src/route-type.ts`.
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
   * Gated on `impliedReturn`, not `routeType === 'out_and_back'`: a trail classified from its
   * own retracing already has both legs in `profile`, and mirroring would double a whole hike.
   * The distinction is not recoverable from the stored row, so anything drawing this profile
   * later rediscovers it by comparing the geometry against `lengthM` — see `hikedProfile`.
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
    // Indexes into the *stored* profile, not the mirrored one used for the arithmetic.
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
 * URL slug, region-qualified because trail names are not unique — every mountainous country
 * has a "Summit Trail", and a numeric suffix tells a reader nothing. The caller adds a suffix
 * only when the qualified form still collides.
 */
export function slugify(name: string, region?: string | null): string {
  const parts = [name, region].filter(Boolean).join(' ');
  const slug = parts
    .normalize('NFKD')
    // Strip the diacritic marks NFKD just separated out, so "Åreskutan" slugs as "areskutan"
    // rather than losing the vowel entirely.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'trail';
}

/**
 * The tsvector input, weighted by field. Postgres `setweight` ranks A above B above C, so
 * "nevis" puts the trail *named* Ben Nevis above one described as near it. Built here rather
 * than in a trigger because `prisma db push` and triggers fight over the column.
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
