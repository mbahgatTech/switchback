import type { LngLat, RouteType, WaypointKind } from '@switchback/core';
import { cumulativeDistancesM, haversineM, nearestPointOnSegment } from './distance';
import { isClosedLoop } from './polyline';

/** How close two points must be to count as "the same place on the ground". */
const OVERLAP_THRESHOLD_M = 30;
/**
 * Points closer than this *along* the route are ignored when looking for overlap —
 * otherwise every point trivially matches its own neighbours and everything looks
 * like an out-and-back.
 */
const ALONG_ROUTE_EXCLUSION_M = 250;
/** Fraction of sampled points that must retrace for an out-and-back verdict. */
const RETRACE_FRACTION = 0.55;

/**
 * Classify a trail as a loop, an out-and-back, or point-to-point.
 *
 * The signal is retracing: on an out-and-back most of the line is hiked twice, so most
 * points have a geometric twin elsewhere on the line that is far away in along-route
 * distance. A loop also returns to its start but never doubles back on itself.
 *
 * Retrace is therefore tested *before* closure. Testing closure first would label every
 * out-and-back a loop, since hiking back to the car closes the line just as surely as
 * a circuit does — the two are indistinguishable by their endpoints alone.
 *
 * Known limitation: OSM frequently stores an out-and-back as its one-way geometry only,
 * with the return leg implied. Such a line has no retrace and open endpoints, so it
 * classifies as point-to-point. That is what this function can honestly say from geometry
 * alone; `hasImpliedReturnLeg` below is the second opinion, and ingest asks both.
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
    // Skip any segment that reaches into the exclusion window around the sample point.
    // Requiring *both* ends to be inside it would leave the segment that starts at the
    // sample point and runs past the window edge — whose nearest point is the sample
    // point itself, at zero distance. Every trail would then look like an out-and-back.
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
 * Out-and-back trails are conventionally advertised by their *round trip* numbers —
 * "8 km, 400 m gain" for a 4 km each-way hike. Matching that convention matters,
 * because a user comparing our figure against a guidebook's will otherwise think one
 * of them is broken.
 */
export function roundTripMultiplier(routeType: RouteType): number {
  return routeType === 'out_and_back' ? 2 : 1;
}

/** Straight-line distance between the two ends — useful for shuttle-needed warnings. */
export function endpointSeparationM(coords: readonly LngLat[]): number {
  if (coords.length < 2) return 0;
  return haversineM(coords[0]!, coords[coords.length - 1]!);
}

// ---------------------------------------------------------------------------
// The implied return leg
// ---------------------------------------------------------------------------

/**
 * Why "point to point" is the wrong answer nine times out of ten, and what to do about it.
 *
 * OSM maps *paths*. A guidebook describes *hikes*. The path from Pen-y-Pass to the summit
 * of Snowdon is drawn once, runs uphill, and ends where the ground does; by geometry it is
 * unarguably point-to-point, and `classifyRouteType` says so. But nobody has ever hiked
 * the Pyg Track point to point, because there is no bus from the summit. The hike is out
 * and back, and every guidebook, every sign at the car park, and every competing app says
 * so. Reporting the geometry instead of the hike is technically true and useless, and it
 * is why 91% of a freshly ingested catalogue reads "Point to point".
 *
 * The missing fact is what is at each end. A line that starts at a road and ends at a
 * summit is a spur: you go up, you look at the view, you come down the way you came. A line
 * that starts at one summit and ends at another is a traverse, and the hike really does end
 * somewhere other than where it began.
 *
 * So the test is asymmetry, not presence. **Exactly one** end is a destination:
 *
 * - summit at one end, nothing at the other  → spur, hiked both ways
 * - summit at both ends (Crib Goch to Snowdon) → ridge traverse, left alone
 * - nothing at either end (a valley path between two villages) → left alone
 *
 * This is deliberately a weaker rule than it could be. The strongest signal available is
 * network connectivity — a far end that no other way touches is a dead end, full stop — and
 * it is not used here because the path graph is fetched lazily for route planning and is
 * simply not in hand when a trail is ingested. Asymmetric termini are what can be known for
 * free from data we already fetch, and being wrong is expensive: an out-and-back verdict
 * doubles every published figure, so a false positive advertises a 5 km hike as 10 km.
 * Hence the length band, the short list of kinds, and the tight radius below.
 */

/**
 * Feature kinds a hike ends *at* rather than passes through.
 *
 * Short on purpose. A summit, a viewpoint, a waterfall and a lake shore are places the path
 * exists in order to reach, and the honest thing to do at one is turn around. Deliberately
 * absent: `shelter` and `campsite`, which are stops on a longer hike at least as often as
 * they are the end of a short one, and every kind — gates, fords, guideposts, toilets —
 * that says nothing at all about whether the ground continues.
 */
export const TERMINAL_DESTINATIONS: readonly WaypointKind[] = [
  'summit',
  'viewpoint',
  'waterfall',
  'lake',
];

const TERMINAL_SET = new Set<WaypointKind>(TERMINAL_DESTINATIONS);

/**
 * How close a feature must be to an endpoint to be *at* it, straight-line.
 *
 * Matches the waypoint buffer ingest already uses, and for the same reason: a summit node
 * sits on the true high point, which is routinely a few dozen metres off the last mapped
 * vertex of the path that climbs to it. Much tighter and real summits stop matching; much
 * looser and a peak the path merely passes below starts to.
 */
export const TERMINUS_RADIUS_M = 150;

/**
 * The longest one-way line we will call an implied out-and-back.
 *
 * Fifteen kilometres each way is a thirty-kilometre day, which is already at the far end of
 * what anyone hikes in one go. Past that, a line ending at a summit is far more likely to be
 * a stage of a long-distance route — where the mapper's endpoints are wherever the relation
 * happens to be split — and doubling its numbers would be a large, confident, visible error.
 */
export const MAX_SPUR_LENGTH_M = 15_000;

/**
 * The shortest line the endpoint test can actually read.
 *
 * Four times the radius, because below that the radius swamps the geometry it is measuring.
 * On a 400 m line a 150 m circle covers most of the ground, so "the summit is at the end"
 * and "the summit is somewhere near this path" become the same statement, and the verdict
 * turns on which end a mapper happened to draw first. Above 600 m the two ends are genuinely
 * distinguishable and the question means something.
 *
 * The floor also filters out what OSM has a lot of at this scale: named crags, ridge
 * fragments, and access scrambles that are pieces of a hike rather than hikes. Those are
 * point-to-point in the only sense that matters — nobody plans a day around them.
 */
export const MIN_SPUR_LENGTH_M = 4 * TERMINUS_RADIUS_M;

/**
 * Names that assert the hike is a circuit, in the languages our catalogue actually contains.
 *
 * Word-bounded so "Rundweg" matches and "Loophole Lane" does not, and matched
 * case-insensitively because OSM `name` is whatever the mapper typed.
 */
const CIRCUIT_NAMES =
  /\b(loop|circular|circuit|rundweg|rundwanderweg|boucle|circuito|anello|rondje)\b/i;

/**
 * Does the trail's own name say it comes back round the other way?
 *
 * The veto on an implied return leg, and it exists because of a specific failure. Yosemite's
 * Valley Loop Trail is mapped in our catalogue as an 8.3 km line that does not close, with a
 * viewpoint at one end — a textbook implied out-and-back by every test above, and wrong. The
 * geometry is half a loop. What is missing is the other half of a circle, not a return along
 * the same ground, so mirroring the profile would invent a descent that does not exist and
 * label the result with the one route type the mapper explicitly ruled out.
 *
 * Doubling would in fact have landed nearer the true distance than leaving it alone did. That
 * is not a reason to do it: a right number under a wrong label, with a fabricated elevation
 * profile behind it, is worse than an honest short one. When the name and the geometry
 * disagree, the geometry is incomplete, and the repair for incomplete geometry is more
 * geometry — not a guess dressed as a measurement.
 */
export function namesACircuit(name: string | undefined | null): boolean {
  return name ? CIRCUIT_NAMES.test(name) : false;
}

/**
 * Names that say this line is a way *through*, not a hike.
 *
 * The generic comes first in French and it is the whole signal: a mountain path is a
 * *sentier*, a **chemin** is a farm lane, and a **route de** is a road. English and German
 * put theirs at either end — "Forest Route 1N10", "Old Mine Road", "Forstweg", and the US
 * Forest Service's "truck trail", which is a fire road.
 *
 * **traverse** earns its place for a different reason: it is the English word for precisely
 * what `isTraverse` detects geometrically, and it works where that function cannot, on the
 * lines with nothing tagged at either end. "Commonwealth Traverse Route" is a through-route
 * by assertion, however much it climbs to get there.
 *
 * `\broute\b` on its own is deliberately not here. Canadian scrambling names it at the *end*
 * — Read's Tower Route, Little Sister Route, Grotto Mountain West Ridge Route — and those are
 * summit approaches hiked out and back, the exact rows the climb rule is right about. Only
 * the French article form is matched, which is why the pattern is anchored rather than free.
 *
 * The boundaries are `\p{L}` lookarounds rather than `\b`, because `\b` is ASCII-only: it
 * treats `é` as a non-word character, so `chemin\b` matches *Cheminée* — a chimney, which is a
 * climbing feature and not a lane at all. `d'` is exempted from the trailing lookaround for
 * the opposite reason: a letter is exactly what follows it in "Route d'Aussois".
 */
const THOROUGHFARE_NAMES =
  /^(?:chemin|voie|piste)(?!\p{L})|^route\s+(?:d'|(?:de|du|des)(?!\p{L}))|(?<!\p{L})(?:road|traverse|forest\s+route|truck\s+trail|strasse|straße|strada|forstweg|fahrweg)(?!\p{L})/iu;

/**
 * Does the trail's own name say it is a lane or a road?
 *
 * The second veto on `climbsToADeadEnd`, and it exists because of a measurement. The climb
 * rule's first pass over the catalogue was right about Snowdon and Yosemite and wrong about a
 * block of Upper Savoy: Chemin de Méry, Chemin des Saugeais, Chemin du Maquis, Chemin de Gers
 * à Béné — Alpine mule tracks that climb from a valley to an alp and genuinely carry on, which
 * is precisely the failure the 400 m bar was chosen to exclude and did not.
 *
 * Steepness cannot separate them: Chemin du Maquis climbs at 29%, steeper than every path on
 * Snowdon, and a ski piste in the same sample sits at 14.9%, between the Watkin and Rhyd Ddu
 * paths. Nor can `activityTypes`, because the ways carry no `piste_type` to read. What is left
 * is what the mapper called it, and in French that happens to be exact.
 *
 * Scoped to the climb rule alone, like `isTraverse`. A chemin with a viewpoint tagged at one
 * end really is hiked to the viewpoint and back; positive evidence at a terminus outranks the
 * name, and only the rule that reads nothing but the shape of the ground defers to it.
 */
export function namesAThoroughfare(name: string | undefined | null): boolean {
  return name ? THOROUGHFARE_NAMES.test(name) : false;
}

/**
 * The climb that stops at the top.
 *
 * The terminus test needs something tagged within 150 m of the end of the line, and the four
 * most-hiked paths on Snowdon do not have that: the Pyg Track, the Miners' Track and the
 * Watkin Path all stop where they meet the Llanberis Path on the ridge, several hundred
 * metres short of the summit node. The Llanberis Path itself reaches it, which is why that
 * one alone was corrected and the rest — the exact trails somebody looking at Snowdon would
 * check first — stayed labelled point-to-point.
 *
 * So the second signal is the shape of the ground rather than what is tagged on it. A line
 * that climbs several hundred metres and whose last sample is essentially its highest has
 * stopped where the ascent stopped. Ground that continues gets mapped; a mapper who drew a
 * path over a pass drew the descent too, and that line's high point sits in the middle. An
 * end that is also the top is a top.
 *
 * "Essentially" is load-bearing, and it was found the expensive way. Read as exact equality —
 * the final sample must be the argmax — this rule missed the Pyg Track, whose high point is
 * sample 185 of 190 because the last 125 m onto the ridge drops *0.4 m*, and the Snowdon
 * Ranger Path, which drops 4.2 m. Terrarium samples carry a few metres of noise and a path
 * flattening onto a summit plateau genuinely undulates. So the test is a drop tolerance, at
 * the same 20 m `orientUphill` uses and for the same reason: comfortably above the noise, far
 * below any descent a hiker would notice. The Miners' Track drops 42 m to Llyn Llydaw and is
 * still correctly refused.
 *
 * `dropFromTopM` is not implied by `orientUphill`, which only compares the two endpoints: a
 * path that tops out and then drops 50 m to a col has net gain and a mid-line high point, and
 * is correctly refused here.
 *
 * The 400 m bar is what separates a mountain from a hillside. Below it the shape stops being
 * distinctive — valley paths that climb 200 m to a road on a shelf and genuinely continue as
 * somebody's commute are common, and doubling one would be the visible kind of wrong. Above
 * it, a line that climbs that far and stops is a summit approach essentially every time.
 */
export const MIN_DEAD_END_CLIMB_M = 400;

/** How far below its own high point a line may finish and still count as finishing on it. */
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
 * Which of the given features sit at each end of the line.
 *
 * Straight-line distance from the endpoint, not distance along the trail: a summit 40 m off
 * the last vertex is at the end of the hike, and its along-trail distance would be the
 * length of the whole line, which says nothing about whether it is the destination.
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
 * Both ends are somewhere worth hiking to.
 *
 * Crib Goch to Snowdon: a summit at each end, and the hike genuinely finishes somewhere other
 * than where it began. This is the veto on `climbsToADeadEnd`, which such a line satisfies
 * trivially — a traverse that finishes on the higher of its two summits climbs several hundred
 * metres and ends at its own high point, and would be doubled on that evidence alone.
 *
 * Positive evidence at both ends beats the absence of evidence the climb rule reads. The climb
 * rule exists for lines with nothing tagged at either end; where OSM has told us what is there,
 * we believe it.
 */
export function isTraverse(termini: TerminusKinds): boolean {
  return termini.start.some(isTerminalDestination) && termini.end.some(isTerminalDestination);
}

/**
 * Does this line's geometry stop short of the hike — one leg drawn, the return implied?
 *
 * Only ever asked of a line that geometry already called point-to-point. Returns true when
 * exactly one end is a destination and the line is the right length to be a spur; see the
 * essay above for why each of those conditions is load-bearing.
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
