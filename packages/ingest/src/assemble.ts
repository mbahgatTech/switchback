/**
 * Turning OSM elements into one ordered line per trail.
 *
 * This is the least glamorous and most load-bearing step in the pipeline. A route
 * relation is an *unordered set* of member ways, and nothing in OSM guarantees they are
 * listed in hiking order, drawn in a consistent direction, or even contiguous. Rendering
 * a trail without fixing that gives you a line that jumps back and forth across the
 * mountain, and every statistic computed from it — length, gain, ETA — is nonsense.
 *
 * So: chain by shared endpoints, reverse whatever needs reversing, bridge the small gaps
 * that are mapping noise, and refuse to bridge the large ones that are two genuinely
 * different trails filed under one relation.
 *
 * Coordinate equality is safe as the join test because `out geom` returns each shared
 * node's position from the same node record, so two ways meeting at a node carry
 * bit-identical coordinates. The epsilon is belt-and-braces against float formatting,
 * not against real geometry.
 */

import type { BBox, LngLat } from '@switchback/core';
import { bboxOf, haversineM, lineLengthM } from '@switchback/geo';
import type { OverpassElement, OverpassRelation, OverpassWay } from './overpass';

/** ~1 cm at the equator. Two endpoints closer than this are the same node. */
const COORD_EPSILON = 1e-7;

/**
 * Gaps up to this are bridged with a straight line. Chosen because it is roughly the
 * width of the features that cause them — a road crossing, an untagged bridge, a stretch
 * one mapper never drew — while being far too short to silently connect two trails that
 * merely end near each other.
 */
export const DEFAULT_GAP_TOLERANCE_M = 40;

/** Below this a "trail" is a driveway stub or a fragment; not worth a row. */
export const MIN_TRAIL_LENGTH_M = 200;

export interface RawWay {
  id: number;
  coords: LngLat[];
  tags: Record<string, string>;
}

/** One contiguous run of ways, in hiking order. */
export interface AssembledLine {
  coords: LngLat[];
  wayIds: number[];
  /** Straight-line distance bridged to build this line. 0 when every join was a shared node. */
  bridgedM: number;
}

function keyOf([lng, lat]: LngLat): string {
  // Quantising to 1e-7 makes the map lookup an exact-match hash rather than a scan, and
  // the quantum is below the precision OSM stores, so it cannot merge distinct nodes.
  return `${lng.toFixed(7)},${lat.toFixed(7)}`;
}

function sameCoord(a: LngLat, b: LngLat): boolean {
  return Math.abs(a[0] - b[0]) < COORD_EPSILON && Math.abs(a[1] - b[1]) < COORD_EPSILON;
}

/** Way geometry from Overpass, in GeoJSON axis order and with degenerate ways dropped. */
export function wayToCoords(way: OverpassWay): LngLat[] | null {
  if (!way.geometry || way.geometry.length < 2) return null;
  const coords: LngLat[] = [];
  for (const point of way.geometry) {
    // Overpass omits positions for nodes outside the query bbox; a way clipped that way
    // has holes, and interpolating across one invents geometry. Better to drop it and let
    // the neighbouring tile — which contains those nodes — contribute the whole way.
    if (typeof point.lat !== 'number' || typeof point.lon !== 'number') return null;
    coords.push([point.lon, point.lat]);
  }
  return coords;
}

/**
 * Chain ways into maximal contiguous lines.
 *
 * Greedy rather than a proper Eulerian path solver, and that is the right trade: a real
 * trail is a path, not a network, so the greedy hike finds the same answer. Where a
 * relation *is* branchy — a trail with a marked alternate, say — greedy produces the main
 * line plus the spur as a second line, and `pickPrimary` keeps the longer one. A path
 * solver would produce a single line that hikes the spur and doubles back, which is worse.
 */
export function chainWays(ways: readonly RawWay[]): AssembledLine[] {
  const usable = ways.filter((w) => w.coords.length >= 2);
  const used = new Set<number>();

  /** endpoint key → indices of unused ways touching it. */
  const endpoints = new Map<string, number[]>();
  usable.forEach((way, index) => {
    for (const end of [way.coords[0]!, way.coords[way.coords.length - 1]!]) {
      const key = keyOf(end);
      const bucket = endpoints.get(key);
      if (bucket) bucket.push(index);
      else endpoints.set(key, [index]);
    }
  });

  function takeAdjacent(at: LngLat, exclude: number): { index: number; way: RawWay } | null {
    for (const index of endpoints.get(keyOf(at)) ?? []) {
      if (index === exclude || used.has(index)) continue;
      return { index, way: usable[index]! };
    }
    return null;
  }

  const lines: AssembledLine[] = [];

  for (let seed = 0; seed < usable.length; seed++) {
    if (used.has(seed)) continue;
    used.add(seed);

    const start = usable[seed]!;
    let coords = [...start.coords];
    const wayIds = [start.id];

    // Forward from the tail.
    for (;;) {
      const tail = coords[coords.length - 1]!;
      const next = takeAdjacent(tail, seed);
      if (!next) break;
      used.add(next.index);
      wayIds.push(next.way.id);
      // The neighbour may be drawn either way round; align it to our tail before joining,
      // and drop its first vertex because it is our last.
      const aligned = sameCoord(next.way.coords[0]!, tail)
        ? next.way.coords
        : [...next.way.coords].reverse();
      coords = coords.concat(aligned.slice(1));
    }

    // Backward from the head, prepending.
    for (;;) {
      const head = coords[0]!;
      const prev = takeAdjacent(head, seed);
      if (!prev) break;
      used.add(prev.index);
      wayIds.unshift(prev.way.id);
      const aligned = sameCoord(prev.way.coords[prev.way.coords.length - 1]!, head)
        ? prev.way.coords
        : [...prev.way.coords].reverse();
      coords = aligned.slice(0, -1).concat(coords);
    }

    lines.push({ coords, wayIds, bridgedM: 0 });
  }

  return lines;
}

/**
 * Join lines whose endpoints are within `toleranceM`, repeatedly, until nothing more
 * joins. Runs after `chainWays` because a shared node is always the better join and
 * should never lose to a nearby-but-different one.
 *
 * O(n²) per pass over segment endpoints. n here is the number of *disconnected runs* in
 * one relation, which is single digits in practice — a relation with hundreds would be
 * broken data, and the length filter downstream discards it anyway.
 */
export function bridgeGaps(lines: readonly AssembledLine[], toleranceM: number): AssembledLine[] {
  const open = lines.map((line) => ({
    ...line,
    coords: [...line.coords],
    wayIds: [...line.wayIds],
  }));

  for (;;) {
    let best: { i: number; j: number; distM: number; flipI: boolean; flipJ: boolean } | null = null;

    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const a = open[i]!;
        const b = open[j]!;
        // Four ways two segments can meet, because either may need reversing.
        const candidates: Array<[LngLat, LngLat, boolean, boolean]> = [
          [a.coords[a.coords.length - 1]!, b.coords[0]!, false, false],
          [a.coords[a.coords.length - 1]!, b.coords[b.coords.length - 1]!, false, true],
          [a.coords[0]!, b.coords[0]!, true, false],
          [a.coords[0]!, b.coords[b.coords.length - 1]!, true, true],
        ];
        for (const [from, to, flipI, flipJ] of candidates) {
          const distM = haversineM(from, to);
          if (distM <= toleranceM && (best === null || distM < best.distM)) {
            best = { i, j, distM, flipI, flipJ };
          }
        }
      }
    }

    if (!best) break;

    const a = open[best.i]!;
    const b = open[best.j]!;
    const aCoords = best.flipI ? [...a.coords].reverse() : a.coords;
    const aIds = best.flipI ? [...a.wayIds].reverse() : a.wayIds;
    const bCoords = best.flipJ ? [...b.coords].reverse() : b.coords;
    const bIds = best.flipJ ? [...b.wayIds].reverse() : b.wayIds;

    open[best.i] = {
      coords: aCoords.concat(bCoords),
      wayIds: aIds.concat(bIds),
      bridgedM: a.bridgedM + b.bridgedM + best.distM,
    };
    open.splice(best.j, 1);
  }

  return open;
}

/**
 * The line a relation is actually about.
 *
 * Longest wins. On a well-mapped relation there is only one line and this is a no-op; on
 * a relation carrying an alternate start or an approach spur it picks the main route,
 * which is what the name on the relation refers to.
 */
export function pickPrimary(lines: readonly AssembledLine[]): AssembledLine | null {
  let best: AssembledLine | null = null;
  let bestLength = -1;
  for (const line of lines) {
    const length = lineLengthM(line.coords);
    if (length > bestLength) {
      best = line;
      bestLength = length;
    }
  }
  return best;
}

/**
 * Drop consecutive duplicate vertices.
 *
 * Bridging and chaining both concatenate at shared endpoints, and a relation that lists
 * the same way twice — common on out-and-back routes mapped as one relation — produces
 * zero-length segments. They contribute nothing to length and they divide by zero in the
 * grade calculation.
 */
export function dedupeVertices(coords: readonly LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const coord of coords) {
    const last = out[out.length - 1];
    if (!last || !sameCoord(last, coord)) out.push(coord);
  }
  return out;
}

export interface AssembledTrail {
  osmType: 'relation' | 'way';
  osmId: number;
  name: string;
  tags: Record<string, string>;
  coords: LngLat[];
  bbox: BBox;
  lengthM: number;
  /** How much of the line was straight-line guesswork. Surfaced so a bad join is visible. */
  bridgedM: number;
  memberWayIds: number[];
}

export interface AssembleOptions {
  gapToleranceM?: number;
  minLengthM?: number;
}

/**
 * Assemble every trail present in one Overpass response.
 *
 * Relations first, and the ways they consume are then excluded from standalone
 * consideration — otherwise a named way inside the Tour du Mont Blanc becomes its own
 * "trail" alongside it, and the map shows the same path twice.
 */
export function assembleTrails(
  elements: readonly OverpassElement[],
  options: AssembleOptions = {},
): AssembledTrail[] {
  const gapToleranceM = options.gapToleranceM ?? DEFAULT_GAP_TOLERANCE_M;
  const minLengthM = options.minLengthM ?? MIN_TRAIL_LENGTH_M;

  const waysById = new Map<number, OverpassWay>();
  const relations: OverpassRelation[] = [];
  for (const element of elements) {
    if (element.type === 'way') waysById.set(element.id, element);
    else if (element.type === 'relation') relations.push(element);
  }

  const trails: AssembledTrail[] = [];
  const claimedWayIds = new Set<number>();

  /**
   * Every way any route relation lists, and the names of the relations we actually emitted.
   *
   * `claimedWayIds` is deliberately narrower than this — it holds only the ways on a
   * relation's *primary* chain, because a relation whose members form two disjoint lines
   * has a real second line that deserves to stay findable. But that narrowness has a cost
   * the map makes obvious: OSM tags the constituent ways of a long route with the route's
   * own name, so "Huckleberry Trail" arrives as a 59 km relation *and* as a 40 km way that
   * fell off the primary chain, and both get committed. The user sees one trail listed
   * twice at two different lengths and has no way to tell which is the real one.
   *
   * These two sets together are the discriminator. A way that some route relation claims
   * as a member *and* carries a name we already emitted as a relation is a fragment of
   * that relation, full stop. A way that a relation claims but names differently — the
   * Mist Trail ways inside the John Muir Trail — is a genuine trail that happens to be
   * hiked as part of a longer one, and dropping it would make a famous trail unsearchable.
   * Requiring both conditions is what separates those two cases.
   */
  const relationMemberWayIds = new Set<number>();
  const relationNames = new Set<string>();

  for (const relation of relations) {
    for (const member of relation.members ?? []) {
      if (member.type === 'way') relationMemberWayIds.add(member.ref);
    }

    const name = relation.tags?.name ?? relation.tags?.['name:en'];
    if (!name) continue;

    const members: RawWay[] = [];
    for (const member of relation.members ?? []) {
      if (member.type !== 'way') continue;
      // Relation members carry inline geometry from `out geom`; fall back to the way
      // element when the member entry is bare, which happens on very large relations.
      const coords = member.geometry
        ? memberToCoords(member.geometry)
        : ((w) => (w ? wayToCoords(w) : null))(waysById.get(member.ref));
      if (!coords) continue;
      members.push({ id: member.ref, coords, tags: waysById.get(member.ref)?.tags ?? {} });
    }
    if (members.length === 0) continue;

    const primary = pickPrimary(bridgeGaps(chainWays(members), gapToleranceM));
    if (!primary) continue;

    const coords = dedupeVertices(primary.coords);
    if (coords.length < 2) continue;
    const lengthM = lineLengthM(coords);
    if (lengthM < minLengthM) continue;

    for (const id of primary.wayIds) claimedWayIds.add(id);
    relationNames.add(normalizeName(name));

    trails.push({
      osmType: 'relation',
      osmId: relation.id,
      name,
      tags: mergeTags(relation.tags ?? {}, primary.wayIds, waysById),
      coords,
      bbox: bboxOf(coords),
      lengthM,
      bridgedM: primary.bridgedM,
      memberWayIds: primary.wayIds,
    });
  }

  /**
   * Standalone named ways, grouped by name so a trail mapped as six consecutive
   * `highway=path` ways with the same name comes out as one trail rather than six.
   * Grouping by name is the only signal available — there is no relation to say so — and
   * the gap tolerance is what stops two unrelated "Ridge Trail"s in the same tile merging.
   */
  const byName = new Map<string, RawWay[]>();
  for (const way of waysById.values()) {
    if (claimedWayIds.has(way.id)) continue;
    const name = way.tags?.name;
    if (!name) continue;
    // A relation member wearing that relation's name is a fragment of it — see the note on
    // `relationMemberWayIds`. Both halves matter; either alone drops real trails.
    if (relationMemberWayIds.has(way.id) && relationNames.has(normalizeName(name))) continue;
    const coords = wayToCoords(way);
    if (!coords) continue;
    const bucket = byName.get(name);
    if (bucket) bucket.push({ id: way.id, coords, tags: way.tags ?? {} });
    else byName.set(name, [{ id: way.id, coords, tags: way.tags ?? {} }]);
  }

  for (const [name, group] of byName) {
    for (const line of bridgeGaps(chainWays(group), gapToleranceM)) {
      const coords = dedupeVertices(line.coords);
      if (coords.length < 2) continue;
      const lengthM = lineLengthM(coords);
      if (lengthM < minLengthM) continue;

      // The lowest way id is stable across ingests, which matters because it is half of
      // the (osmType, osmId) unique key that makes re-ingesting a tile an update rather
      // than a duplicate.
      const osmId = Math.min(...line.wayIds);
      trails.push({
        osmType: 'way',
        osmId,
        name,
        tags: mergeTags({}, line.wayIds, waysById),
        coords,
        bbox: bboxOf(coords),
        lengthM,
        bridgedM: line.bridgedM,
        memberWayIds: line.wayIds,
      });
    }
  }

  return trails;
}

/**
 * Trail names as OSM actually types them, reduced to something comparable.
 *
 * Casing and spacing drift between a relation and the ways beneath it — "Huckleberry
 * Trail" against "Huckleberry trail", a stray double space — and a fragment check that
 * misses on whitespace is a fragment check that does nothing. Nothing stronger than case
 * and whitespace is folded, because "North Ridge Trail" and "South Ridge Trail" are two
 * trails and any punctuation-stripping clever enough to merge names is clever enough to
 * merge those.
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function memberToCoords(geometry: Array<{ lat: number; lon: number }>): LngLat[] | null {
  if (geometry.length < 2) return null;
  const coords: LngLat[] = [];
  for (const point of geometry) {
    if (typeof point.lat !== 'number' || typeof point.lon !== 'number') return null;
    coords.push([point.lon, point.lat]);
  }
  return coords;
}

/**
 * Relation tags win; member-way tags fill the gaps.
 *
 * Physical attributes — surface, sac_scale, access — live on the ways, because that is
 * where they physically vary. Descriptive ones live on the relation. Taking the majority
 * value across members rather than the first means one stretch of boardwalk does not
 * relabel a 12 km mountain path as `surface=wood`.
 */
function mergeTags(
  relationTags: Record<string, string>,
  wayIds: readonly number[],
  waysById: ReadonlyMap<number, OverpassWay>,
): Record<string, string> {
  const INHERITED = [
    'surface',
    'sac_scale',
    'trail_visibility',
    'highway',
    'access',
    'dog',
    'wheelchair',
    'fee',
    'bicycle',
    'horse',
    'mtb:scale',
    'incline',
    'width',
  ];

  const votes = new Map<string, Map<string, number>>();
  for (const id of wayIds) {
    const tags = waysById.get(id)?.tags;
    if (!tags) continue;
    for (const key of INHERITED) {
      const value = tags[key];
      if (!value) continue;
      const counts = votes.get(key) ?? new Map<string, number>();
      counts.set(value, (counts.get(value) ?? 0) + 1);
      votes.set(key, counts);
    }
  }

  const merged: Record<string, string> = { ...relationTags };
  for (const [key, counts] of votes) {
    if (merged[key] !== undefined) continue;
    let winner = '';
    let best = 0;
    for (const [value, count] of counts) {
      if (count > best) {
        winner = value;
        best = count;
      }
    }
    if (winner) merged[key] = winner;
  }
  return merged;
}
