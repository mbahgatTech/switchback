import type { LngLat, RouteType, WaypointKind } from '@switchback/core';
import { cumulativeDistancesM, haversineM, nearestPointOnSegment } from './distance';
import { isClosedLoop } from './polyline';

/** How close two points must be to count as "the same place on the ground". */
const OVERLAP_THRESHOLD_M = 30;
/** Points this close *along* the route are ignored, or every point matches its own neighbours. */
const ALONG_ROUTE_EXCLUSION_M = 250;
/** Fraction of sampled points that must retrace for an out-and-back verdict. */
const RETRACE_FRACTION = 0.55;

/**
 * Classify a trail as a loop, an out-and-back, or point-to-point, from geometry alone.
 *
 * Retrace is tested before closure: hiking back to the car closes the line just as a circuit
 * does, so testing closure first would label every out-and-back a loop. OSM often stores an
 * out-and-back as one-way geometry with the return implied — such a line has no retrace and
 * open ends, so `hasImpliedReturnLeg` below is the second opinion and ingest asks both.
 */
export function classifyRouteType(coords: readonly LngLat[], loopThresholdM = 200): RouteType {
  if (coords.length < 3) return 'point_to_point';
  if (retraceFraction(coords) >= RETRACE_FRACTION) return 'out_and_back';
  return isClosedLoop(coords, loopThresholdM) ? 'loop' : 'point_to_point';
}

/**
 * Proportion of the line that is hiked twice, in [0, 1].
 * Exported because it is a useful diagnostic when a classification looks wrong.
 */
export function retraceFraction(coords: readonly LngLat[], sampleCount = 60): number {
  if (coords.length < 3) return 0;

  const cum = cumulativeDistancesM(coords);
  const total = cum[cum.length - 1]!;
  if (total < ALONG_ROUTE_EXCLUSION_M * 2) return 0;

  const samples = Math.min(sampleCount, coords.length);
  let retraced = 0;

  for (let s = 0; s < samples; s++) {
    const target = (total * s) / (samples - 1 || 1);
    const idx = indexAtDistance(cum, target);
    const point = coords[idx]!;

    if (hasDistantTwin(point, coords, cum, cum[idx]!)) retraced++;
  }

  return retraced / samples;
}

/** Is there a point elsewhere on the line — far along it — within OVERLAP_THRESHOLD_M? */
function hasDistantTwin(
  point: LngLat,
  coords: readonly LngLat[],
  cum: readonly number[],
  atDistM: number,
): boolean {
  for (let i = 1; i < coords.length; i++) {
    const alongA = cum[i - 1]!;
    const alongB = cum[i]!;
    // Skip any segment reaching into the exclusion window. Requiring *both* ends inside it
    // would leave the segment starting at the sample point, whose nearest point is the sample
    // point itself at zero distance — every trail would look like an out-and-back.
    if (alongB > atDistM - ALONG_ROUTE_EXCLUSION_M && alongA < atDistM + ALONG_ROUTE_EXCLUSION_M) {
      continue;
    }
    if (nearestPointOnSegment(point, coords[i - 1]!, coords[i]!).distM <= OVERLAP_THRESHOLD_M) {
      return true;
    }
  }
  return false;
}

function indexAtDistance(cum: readonly number[], distM: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= distM) lo = mid;
    else hi = mid;
  }
  return distM - cum[lo]! <= cum[hi]! - distM ? lo : hi;
}

/**
 * Out-and-backs are conventionally advertised by round-trip numbers, so a reader comparing our
 * figure against a guidebook's does not conclude one of them is broken.
 */
export function roundTripMultiplier(routeType: RouteType): number {
  return routeType === 'out_and_back' ? 2 : 1;
}

/** Straight-line distance between the two ends — useful for shuttle-needed warnings. */
export function endpointSeparationM(coords: readonly LngLat[]): number {
  if (coords.length < 2) return 0;
  return haversineM(coords[0]!, coords[coords.length - 1]!);
}

/**
 * The implied return leg. OSM maps paths, guidebooks describe hikes: a spur drawn once from a
 * road to a summit is unarguably point-to-point by geometry, and reporting that left 91% of a
 * fresh catalogue reading "Point to point". The test is asymmetric termini — exactly one end a
 * destination means a spur hiked both ways; both ends (Crib Goch to Snowdon) is a traverse;
 * neither is left alone. Network connectivity would be the stronger signal but the path graph
 * is not in hand at ingest. A false positive doubles every published figure, hence the length
 * band, the short kind list and the tight radius below.
 */

/**
 * Feature kinds a hike ends *at* rather than passes through. Deliberately excludes `shelter`
 * and `campsite`, which are stops on a longer hike at least as often as an endpoint.
 */
export const TERMINAL_DESTINATIONS: readonly WaypointKind[] = [
  'summit',
  'viewpoint',
  'waterfall',
  'lake',
];

const TERMINAL_SET = new Set<WaypointKind>(TERMINAL_DESTINATIONS);

/**
 * How close a feature must be to an endpoint to be *at* it, straight-line. Matches ingest's
 * waypoint buffer: a summit node sits on the true high point, tens of metres off the last vertex.
 */
export const TERMINUS_RADIUS_M = 150;

/**
 * The longest one-way line we will call an implied out-and-back. Past 15 km each way, a line
 * ending at a summit is more likely a stage of a long-distance route split by its relation.
 */
export const MAX_SPUR_LENGTH_M = 15_000;

/**
 * The shortest line the endpoint test can read: four times the radius, below which a 150 m
 * circle covers most of the ground and the verdict turns on which end the mapper drew first.
 */
export const MIN_SPUR_LENGTH_M = 4 * TERMINUS_RADIUS_M;

/** Names asserting a circuit, in the catalogue's languages. Word-bounded so "Loophole" misses. */
const CIRCUIT_NAMES =
  /\b(loop|circular|circuit|rundweg|rundwanderweg|boucle|circuito|anello|rondje)\b/i;

/**
 * Veto on an implied return leg. Yosemite's Valley Loop Trail is mapped as an 8.3 km open line
 * with a viewpoint at one end — half a loop, so mirroring it would invent a descent that does
 * not exist. When name and geometry disagree the geometry is incomplete, and the repair for
 * incomplete geometry is more geometry, not a guess dressed as a measurement.
 */
export function namesACircuit(name: string | undefined | null): boolean {
  return name ? CIRCUIT_NAMES.test(name) : false;
}

/**
 * Names that say this line is a way *through*, not a hike. `\broute\b` alone is deliberately
 * absent: Canadian scrambling puts it at the end (Read's Tower Route), which are summit
 * approaches hiked out and back, so only the French article form is matched.
 *
 * Boundaries are `\p{L}` lookarounds, not `\b`: `\b` is ASCII-only and treats `é` as a
 * non-word character, so `chemin\b` would match *Cheminée*, a climbing feature. `d'` is
 * exempted from the trailing lookaround because a letter is what follows it in "Route d'Aussois".
 */
const THOROUGHFARE_NAMES =
  /^(?:chemin|voie|piste)(?!\p{L})|^route\s+(?:d'|(?:de|du|des)(?!\p{L}))|(?<!\p{L})(?:road|traverse|forest\s+route|truck\s+trail|strasse|straße|strada|forstweg|fahrweg)(?!\p{L})/iu;

/**
 * Second veto on `climbsToADeadEnd` only. Alpine mule tracks (Chemin du Maquis climbs at 29%)
 * clear the climb bar and genuinely carry on; steepness and `activityTypes` cannot separate
 * them, so the mapper's word is all that is left. Positive evidence at a terminus outranks it.
 */
export function namesAThoroughfare(name: string | undefined | null): boolean {
  return name ? THOROUGHFARE_NAMES.test(name) : false;
}

/**
 * The climb that stops at the top: a line climbing this far and ending at its own high point
 * has stopped where the ascent stopped. Reads the shape of the ground rather than tags, because
 * the Pyg, Miners' and Watkin paths all end on the ridge, short of Snowdon's summit node.
 * Below 400 m the shape stops being distinctive — valley paths climbing to a shelf continue.
 */
export const MIN_DEAD_END_CLIMB_M = 400;

/**
 * How far below its own high point a line may finish and still count as finishing on it. A
 * tolerance, not exact argmax: the Pyg Track drops 0.4 m onto the ridge and would be missed.
 */
export const TOP_TOLERANCE_M = 20;

export function climbsToADeadEnd(input: {
  netGainM: number;
  /** Metres between the line's highest sample and its last. Zero when the last *is* the highest. */
  dropFromTopM: number;
  lengthM: number;
  minClimbM?: number;
  minLengthM?: number;
  maxLengthM?: number;
  topToleranceM?: number;
}): boolean {
  const {
    netGainM,
    dropFromTopM,
    lengthM,
    minClimbM = MIN_DEAD_END_CLIMB_M,
    minLengthM = MIN_SPUR_LENGTH_M,
    maxLengthM = MAX_SPUR_LENGTH_M,
    topToleranceM = TOP_TOLERANCE_M,
  } = input;
  if (!Number.isFinite(dropFromTopM) || dropFromTopM > topToleranceM) return false;
  if (!Number.isFinite(lengthM) || lengthM < minLengthM || lengthM > maxLengthM) return false;
  return Number.isFinite(netGainM) && netGainM >= minClimbM;
}

/** What sits at each end of a line. Order is the line's own; the test below is symmetric. */
export interface TerminusKinds {
  start: readonly WaypointKind[];
  end: readonly WaypointKind[];
}

/** A feature with a position, which is all this file needs to know about one. */
export interface PlacedFeature {
  at: LngLat;
  kind: WaypointKind;
}

/** Whether this kind is somewhere a hike finishes. */
export function isTerminalDestination(kind: WaypointKind): boolean {
  return TERMINAL_SET.has(kind);
}

/**
 * Which of the given features sit at each end. Straight-line distance from the endpoint, not
 * along the trail — a summit 40 m off the last vertex is at the end of the hike.
 */
export function terminusKinds(
  coords: readonly LngLat[],
  features: readonly PlacedFeature[],
  radiusM = TERMINUS_RADIUS_M,
): TerminusKinds {
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (!first || !last || coords.length < 2) return { start: [], end: [] };

  const start: WaypointKind[] = [];
  const end: WaypointKind[] = [];

  for (const feature of features) {
    if (haversineM(feature.at, first) <= radiusM) start.push(feature.kind);
    if (haversineM(feature.at, last) <= radiusM) end.push(feature.kind);
  }

  return { start, end };
}

/**
 * Both ends are destinations — a traverse. The veto on `climbsToADeadEnd`, which a traverse
 * finishing on the higher of its two summits satisfies trivially and would be doubled on.
 */
export function isTraverse(termini: TerminusKinds): boolean {
  return termini.start.some(isTerminalDestination) && termini.end.some(isTerminalDestination);
}

/**
 * One leg drawn, the return implied. Only ever asked of a line geometry already called
 * point-to-point: true when exactly one end is a destination and the length is in the spur band.
 */
export function hasImpliedReturnLeg(
  termini: TerminusKinds,
  lengthM: number,
  maxLengthM = MAX_SPUR_LENGTH_M,
  minLengthM = MIN_SPUR_LENGTH_M,
): boolean {
  if (!Number.isFinite(lengthM) || lengthM < minLengthM || lengthM > maxLengthM) return false;
  const startIsDestination = termini.start.some(isTerminalDestination);
  const endIsDestination = termini.end.some(isTerminalDestination);
  return startIsDestination !== endIsDestination;
}
