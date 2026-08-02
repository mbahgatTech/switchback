/**
 * Display names that say where a trail goes — "Vesper Peak via Headlee Pass Trail". Derived
 * from waypoints alone; `trails.name` and `trails.slug` are the OSM name and never change.
 */

import type { RouteType, WaypointKind } from './types';

/**
 * How far above the trail's own high point a summit may stand and still be one the trail
 * reaches. Read against the peak's own `ele` tag: a DEM sampled at 25 m under-reads a sharp
 * top by a few metres, so exactness would refuse trails that plainly do summit. Where the tag
 * is missing it falls back to the weaker on-trail test in `topsOutHere`, which asks a
 * different question and cannot answer this one.
 */
export const SUMMIT_TOP_TOLERANCE_M = 30;

/**
 * Published gain below which calling the walk a summit hike oversells it. Not the 400 m of
 * `MIN_DEAD_END_CLIMB_M` in @switchback/geo, which reads one-way net gain to decide the shape of
 * a line; this reads the round-trip figure already on the card, where 150 m is a real ascent to
 * a top — Little Si is 377 m — and 20 m is a knoll beside a flat path.
 */
export const MIN_SUMMIT_CLIMB_M = 150;

/**
 * How far the ground must rise from the trail's low point to its high point. `gainM` alone
 * cannot carry the claim: for a mirrored out-and-back it is the round trip, `gain_out +
 * loss_out`, so an undulating path banks 531 m of "gain" over 128 m of relief without ever
 * climbing to anything. Relief is the one number that says the trail ends up somewhere high.
 */
export const MIN_SUMMIT_RELIEF_M = 150;

/**
 * The longest walk out we will call the point of the hike. Past this the feature is something a
 * long-distance route passes: the Coast to Coast Walk reaches Richmond Falls at 122 km and is
 * not "Richmond Falls via the Coast to Coast Walk". Deliberately the same 15 km as
 * `MAX_SPUR_LENGTH_M` in @switchback/geo, which draws the same line for the same reason.
 */
export const MAX_APPROACH_M = 15_000;

/**
 * How far along the walk out a destination must sit to be its far end. Measured: named summits
 * on out-and-backs cluster at the turnaround, and the ones that do not are pass-bys — the
 * viewpoint 40% along the Claife Heights walk is scenery, not where anyone is going.
 */
export const FAR_END_FRACTION = 0.75;

/**
 * Longest display name we will emit. Past this a card truncates it mid-place-name and the reader
 * learns less than the OSM name alone would have told them, so we return null instead.
 */
export const MAX_DISPLAY_NAME_LENGTH = 72;

/**
 * Non-summit features a hike is named for, most distinctive first. A trail ends at exactly one
 * lake or waterfall; viewpoints are scattered and come last, so a named lake outranks the
 * overlook beside it rather than the pair cancelling out as an ambiguity.
 */
export const DESTINATION_KINDS: readonly WaypointKind[] = [
  'lake',
  'waterfall',
  'glacier',
  'pass',
  'viewpoint',
];

/** The waypoint fields naming needs — a subset of `Waypoint`, so rows can be passed straight in. */
export interface DestinationCandidate {
  kind: WaypointKind;
  name: string | null;
  /** Distance along the stored line. Null for a feature near the trail but not on it. */
  distM: number | null;
  /** The trail's elevation where it passes this feature — bounded above by `maxEleM`. */
  eleM: number | null;
  /** The feature's own OSM `ele`, in metres. The peak's height. Null when untagged. */
  osmEleM?: number | null;
}

export interface DisplayNameInput {
  /** The OSM name, unchanged. May be empty for an unnamed way. */
  name: string;
  routeType: RouteType;
  /** Published length: the round trip for an out-and-back. */
  lengthM: number;
  /**
   * Along-line length of the stored geometry — the distances `waypoints[].distM` are measured
   * in. Not `lengthM`: 763 trails store a line more than 2% longer than their published figure.
   */
  lineLengthM: number;
  gainM: number;
  minEleM: number;
  maxEleM: number;
  waypoints: readonly DestinationCandidate[];
}

/** Which clause produced the name, so a backfill can report its work rule by rule. */
export type DisplayNameRule = 'summit' | 'destination';

export interface DisplayName {
  displayName: string;
  /** The feature the hike is named for, exactly as OSM spells it. */
  destination: string;
  rule: DisplayNameRule;
}

/**
 * The two fields titling needs. `displayName` is optional rather than `string | null` because a
 * record stored before the column existed — an offline download on a phone — has no such key.
 */
export interface TitledTrail {
  name: string;
  displayName?: string | null;
}

/** The derived title where there is a usable one. Absent, null and blank all count as none. */
export function displayNameOf(trail: TitledTrail): string | null {
  const derived = trail.displayName?.trim();
  return derived ? derived : null;
}

/**
 * What a reader is shown: the derived name where there is one, the OSM name otherwise. Null is
 * the common answer from `deriveDisplayName`, so every title in web and iOS alike goes through
 * here rather than repeating a `??` that is easy to forget — or drifting apart, which is what
 * two hand-written fallbacks did before this was one function.
 */
export function trailTitle(trail: TitledTrail): string {
  return displayNameOf(trail) ?? trail.name;
}

/**
 * The destination display name, or null to fall back to `name`. Null is the common answer and
 * the safe one: a plausible wrong title — "Ben Nevis via Some Farm Track" — is worse than the
 * farm track's own name, so every clause below refuses rather than guesses.
 */
export function deriveDisplayName(input: DisplayNameInput): string | null {
  return describeDisplayName(input)?.displayName ?? null;
}

/** As `deriveDisplayName`, with the destination and the rule that fired. */
export function describeDisplayName(input: DisplayNameInput): DisplayName | null {
  const summit = summitAtHighPoint(input);
  if (summit) return compose(input.name, summit, 'summit');

  const destination = destinationAtFarEnd(input);
  if (destination) return compose(input.name, destination, 'destination');

  return null;
}

/**
 * Why nothing was published, most specific first. Ordered so that "the summit clause got
 * furthest" beats "the destination clause never started", which is what a coverage report
 * wants to know: `nothing_named_nearby` means there was nothing to work with, and every other
 * value means there was and a named test rejected it.
 */
export type DisplayNameRefusal =
  | 'named'
  | 'nothing_named_nearby'
  | 'gain_below_floor'
  | 'relief_below_floor'
  | 'peak_above_trail'
  | 'not_the_trails_high_point'
  | 'several_summits'
  | 'summit_not_at_far_end'
  | 'not_out_and_back'
  | 'no_destination_at_far_end'
  | 'several_destinations'
  | 'unusable_name';

/**
 * The first test that refused, for a backfill's report. Walks the same clauses in the same
 * order through the same predicates as `describeDisplayName`, so the reason it prints is the
 * reason the name was withheld and not a second opinion that can drift from it.
 */
export function refuseDisplayName(input: DisplayNameInput): DisplayNameRefusal {
  if (describeDisplayName(input)) return 'named';

  const summits = input.waypoints.filter((w) => w.kind === 'summit' && isNamed(w));
  if (summits.length > 0 && Number.isFinite(input.maxEleM)) {
    return refuseSummit(summits, input);
  }

  const destinations = input.waypoints.filter((w) => DESTINATION_KINDS.includes(w.kind));
  if (!destinations.some(isNamed)) return 'nothing_named_nearby';
  if (input.routeType !== 'out_and_back') return 'not_out_and_back';

  const candidates = destinations.filter((w) => isNamed(w) && atFarEnd(w, input));
  if (candidates.length === 0) return 'no_destination_at_far_end';
  const best = DESTINATION_KINDS.find((kind) => candidates.some((w) => w.kind === kind));
  return candidates.filter((w) => w.kind === best).length > 1
    ? 'several_destinations'
    : 'unusable_name';
}

function refuseSummit(
  summits: readonly DestinationCandidate[],
  input: DisplayNameInput,
): DisplayNameRefusal {
  if (!(input.gainM >= MIN_SUMMIT_CLIMB_M)) return 'gain_below_floor';
  if (!(input.maxEleM - input.minEleM >= MIN_SUMMIT_RELIEF_M)) return 'relief_below_floor';
  if (!summits.some((w) => reachesTheTop(w, input))) return 'peak_above_trail';

  const atTop = summits.filter((w) => reachesTheTop(w, input) && topsOutHere(w, input));
  if (atTop.length === 0) return 'not_the_trails_high_point';
  if (atTop.length > 1) return 'several_summits';
  if (!atFarEnd(atTop[0]!, input)) return 'summit_not_at_far_end';
  // Past every positional test, so the summit was found and `compose` is what threw it away.
  return 'unusable_name';
}

/**
 * Where the walk out ends, in the stored line's own distances — the domain `distM` is measured
 * in. For an out-and-back that is either the whole line (ingest drew one leg and mirrored it,
 * publishing double) or half of it (the mapper drew both legs). Which one is recoverable from
 * the two lengths, and `hikedProfile` in @switchback/geo splits the same hair the same way.
 */
export function turnaroundM(routeType: RouteType, lengthM: number, lineLengthM: number): number {
  if (routeType !== 'out_and_back') return lineLengthM;
  // Without a published length there is no telling the two apart, and guessing picks between
  // a walk and half of one. NaN propagates into `atFarEnd`, which refuses on it.
  if (!Number.isFinite(lengthM)) return Number.NaN;
  const mirrored = Math.abs(2 * lineLengthM - lengthM) < Math.abs(lineLengthM - lengthM);
  return mirrored ? lineLengthM : lineLengthM / 2;
}

/**
 * The named summit the trail climbs to, if exactly one is. More than one is a ridge — the
 * French Creek Trail passes Boulder Peak, French Creek Ridge and Byars Peak within 14 m of each
 * other — and nothing in the data says which of them the walk is for, so we say nothing.
 */
function summitAtHighPoint(input: DisplayNameInput): string | null {
  if (!Number.isFinite(input.maxEleM) || !(input.gainM >= MIN_SUMMIT_CLIMB_M)) return null;
  if (!(input.maxEleM - input.minEleM >= MIN_SUMMIT_RELIEF_M)) return null;

  const atTop = input.waypoints.filter(
    (w) => w.kind === 'summit' && isNamed(w) && reachesTheTop(w, input) && topsOutHere(w, input),
  );
  if (atTop.length !== 1) return null;

  return atFarEnd(atTop[0]!, input) ? atTop[0]!.name : null;
}

/**
 * Is the peak itself within reach of the trail's high point? The one test that compares the
 * two mountains rather than the trail against itself: 20% of summit titles measured named a
 * peak standing more than this far above anything their trail reaches. Untagged peaks — four
 * in every two hundred — answer true and are left to `topsOutHere` alone, which is where this
 * clause stood before and no worse than it was.
 */
function reachesTheTop(waypoint: DestinationCandidate, input: DisplayNameInput): boolean {
  const peakEle = waypoint.osmEleM;
  if (peakEle === null || peakEle === undefined || !Number.isFinite(peakEle)) return true;
  return peakEle - input.maxEleM <= SUMMIT_TOP_TOLERANCE_M;
}

/**
 * Does the trail top out where it passes this feature? `eleM` is the profile sample nearest the
 * waypoint's along-track distance — the trail's own elevation, never the peak's — so this
 * places the summit at the top of the *walk* and says nothing about the top of the mountain.
 */
function topsOutHere(waypoint: DestinationCandidate, input: DisplayNameInput): boolean {
  return (
    waypoint.eleM !== null && Math.abs(input.maxEleM - waypoint.eleM) <= SUMMIT_TOP_TOLERANCE_M
  );
}

/**
 * The named lake, waterfall, glacier, pass or viewpoint the trail dead-ends at. Restricted to
 * out-and-backs on purpose: ingest already reclassifies a spur that merely *reads* as one-way,
 * so a line still called point-to-point is one our own classifier declined to call a dead end,
 * and naming it for whatever sits near its far vertex would quietly overrule that.
 */
function destinationAtFarEnd(input: DisplayNameInput): string | null {
  if (input.routeType !== 'out_and_back') return null;

  const candidates = input.waypoints.filter(
    (w) => DESTINATION_KINDS.includes(w.kind) && isNamed(w) && atFarEnd(w, input),
  );
  const best = DESTINATION_KINDS.find((kind) => candidates.some((w) => w.kind === kind));
  const chosen = candidates.filter((w) => w.kind === best);
  // Two waterfalls at the same far end and the walk is for both — "Firewater Falls via
  // Naturaland Trust Trail #14" would quietly drop the other one.
  return chosen.length === 1 ? chosen[0]!.name : null;
}

/**
 * Is this feature at the end of the walk rather than beside it? Loops are exempt, and not as a
 * concession: a circuit's start is wherever the mapper began drawing, so a position along it
 * carries no information about the hike — 22% round one loop and 90% round another say the same
 * nothing. What holds a loop together is the summit clause's own evidence, which does not
 * depend on position, plus the length cap below, which applies to all three shapes.
 */
function atFarEnd(waypoint: DestinationCandidate, input: DisplayNameInput): boolean {
  const { distM } = waypoint;
  if (distM === null || !Number.isFinite(distM)) return false;

  const end = turnaroundM(input.routeType, input.lengthM, input.lineLengthM);
  if (!Number.isFinite(end) || end <= 0 || end > MAX_APPROACH_M) return false;

  return input.routeType === 'loop' || distM >= FAR_END_FRACTION * end;
}

function isNamed(waypoint: DestinationCandidate): waypoint is DestinationCandidate & {
  name: string;
} {
  return typeof waypoint.name === 'string' && waypoint.name.trim().length > 0;
}

/**
 * "<Destination> via <trail>", or the destination alone when the trail has no name of its own to
 * put after it. Refuses when the trail is already named for the destination, when the
 * destination has no name of substance, and when the result is too long to read.
 */
function compose(
  trailName: string,
  destination: string,
  rule: DisplayNameRule,
): DisplayName | null {
  const trail = trailName.trim();
  // OSM names beginning with a bracket or a quote — `"El Salto'l Chordonal"`, `(Les Otanes)` —
  // are tagging accidents, and a title is the wrong place to reproduce one.
  if (!/^[\p{L}\p{N}]/u.test(destination)) return null;

  const distinctive = distinctiveWords(destination);
  if (distinctive.length === 0) return null;

  const named = trail.length > 0 && !isBarePathWord(trail);
  if (named && namesTheDestination(trail, distinctive)) return null;

  const displayName = named ? `${destination} via ${trail}` : destination;
  return displayName.length > MAX_DISPLAY_NAME_LENGTH ? null : { displayName, destination, rule };
}

/**
 * Does the trail's name already say where it goes? True when it repeats any distinctive word of
 * the destination — "Mount Si Trail" for Mount Si, but also "Burroughs Mountain Trail" for 3rd
 * Burroughs Mountain, which containment in either direction misses. One shared word is enough
 * because the reader has already been told; a title that tells them twice is worse than the OSM
 * name, and this file would rather say nothing than say it twice.
 */
export function namesTheDestination(trailName: string, destination: string | string[]): boolean {
  const distinctive = Array.isArray(destination) ? destination : distinctiveWords(destination);
  if (distinctive.length === 0) return false;
  const trail = new Set(tokenise(trailName));
  return distinctive.some((word) => trail.has(word));
}

/**
 * The words in a name that identify the place, dropping the ones every third summit shares. A
 * destination left with none of them — "Viewpoint 630'", "South View" — is a label a mapper
 * reached for when the place had no name, and it names nothing a hike can be titled for.
 */
export function distinctiveWords(name: string): string[] {
  return tokenise(name).filter(
    (token) => !PATH_WORDS.has(token) && !PLACE_WORDS.has(token) && !isReference(token),
  );
}

/**
 * Lowercase word tokens. Diacritics are folded so "Åreskutan" and "Areskutan" compare equal,
 * apostrophes are closed up so "Gobbler's" meets "Gobblers", and the abbreviations OSM mixes
 * freely within one massif are spelled out — half of Mt. Rainier's paths say "Mt".
 */
function tokenise(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/['’]/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) => ABBREVIATIONS.get(token) ?? token);
}

const ABBREVIATIONS = new Map([
  ['mt', 'mount'],
  ['mtn', 'mountain'],
  ['mnt', 'mount'],
  ['st', 'saint'],
]);

/** Route numbers and forest-road codes: "Trail 140", "#3349", "9703-112". */
function isReference(token: string): boolean {
  return /^\d+$/u.test(token);
}

/**
 * Words that classify a path rather than name one, and the articles binding them together.
 * "footpath" is one of these and nothing else, so it is not a name; "Chemin de la Cascade" is
 * the Cascade's path and very much is.
 */
const PATH_WORDS = new Set([
  // The path itself, in the catalogue's languages.
  'trail',
  'trails',
  'path',
  'pathway',
  'footpath',
  'track',
  'route',
  'way',
  'road',
  'loop',
  'spur',
  'sentier',
  'chemin',
  'voie',
  'piste',
  'weg',
  'wanderweg',
  'rundweg',
  'steig',
  'pfad',
  'sendero',
  'camino',
  'ruta',
  'trilha',
  'strada',
  'via',
  // Articles and connectives.
  'the',
  'of',
  'and',
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'el',
  'los',
  'las',
  'del',
  'di',
  'dei',
  'der',
  'den',
  'al',
  'a',
  'to',
  'y',
  'e',
]);

/**
 * Landform nouns and bearings — the words half the peaks in any range share. Kept to ones a
 * reader would never use alone to say where they went: "Lookout Mountain" is deliberately
 * absent, because Lookout is what that one is called.
 */
const PLACE_WORDS = new Set([
  'mount',
  'mountain',
  'mountains',
  'monte',
  'mont',
  'berg',
  'peak',
  'peaks',
  'pic',
  'pico',
  'cima',
  'summit',
  'hill',
  'hills',
  'butte',
  'buttes',
  'ridge',
  'knob',
  'dome',
  'point',
  'top',
  'col',
  'pass',
  'saddle',
  'gap',
  'glacier',
  'lake',
  'lakes',
  'tarn',
  'loch',
  'llyn',
  'lac',
  'lago',
  'falls',
  'fall',
  'waterfall',
  'cascade',
  'viewpoint',
  'view',
  'overlook',
  'mirador',
  'belvedere',
  'north',
  'south',
  'east',
  'west',
  'northern',
  'southern',
  'eastern',
  'western',
]);

/** A name that is only a path classification — "footpath" — says nothing the map does not. */
function isBarePathWord(name: string): boolean {
  const parts = tokenise(name);
  // Landforms and bearings are deliberately not counted: "East Ridge Trail" is a name, and
  // dropping it would publish the destination on its own and lose the route the reader takes.
  // "Trail 140" is excluded too — the number is the name, and locals use it.
  return parts.length > 0 && parts.every((token) => PATH_WORDS.has(token));
}
