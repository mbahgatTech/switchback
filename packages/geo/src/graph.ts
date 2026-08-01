import type { LngLat, PathKind, PathSegment } from '@switchback/core';
import { haversineM } from './distance';
import {
  SURFACE_TERRAIN_FACTOR,
  TOBLER_BASE_KMH,
  terrainFactorFor,
  toblerSpeedKmh,
} from './tobler';

/**
 * The walkable network as a searchable graph, built identically on server and browser so
 * dragging a waypoint re-routes without a round trip.
 *
 * Two deliberate departures from textbook routing. Every vertex is a node rather than
 * contracting chains between junctions, so a pin dropped mid-ridge snaps to OSM's own
 * resolution instead of the next junction 400 m away. And nodes match on exact coordinates,
 * never a tolerance: a footbridge and the path beneath it pass within a metre, and a
 * two-metre quantum would weld them together and route someone off a bridge.
 */

/**
 * How much a hiker would rather be on this than something else, as a multiplier on time.
 * Always ≥ 1, and a multiplier rather than a speed subtraction so the A* heuristic stays
 * admissible (see `heuristicS`). Without it the router paves everything: Tobler makes tarmac
 * faster than dirt, so pure fastest-path beats the parallel path through the trees every time.
 */
export const KIND_PENALTY: Record<PathKind, number> = {
  path: 1,
  footway: 1.05,
  bridleway: 1.05,
  track: 1.1,
  cycleway: 1.15,
  pedestrian: 1.15,
  steps: 1.25,
  road: 1.7,
};

/**
 * The fastest anyone can move on any edge, km/h. Derived from the tables, not written down: a
 * hard-coded bound stops bounding the day a faster surface is added, and an inadmissible
 * heuristic does not throw — it quietly returns a route that is not the best one.
 */
export const MAX_HIKE_SPEED_KMH =
  TOBLER_BASE_KMH * Math.max(1, ...Object.values(SURFACE_TERRAIN_FACTOR));

/** Snapping beyond this is a miss, not a snap. Roughly how far off a path you can stand. */
export const DEFAULT_SNAP_RADIUS_M = 120;

/** The provenance and cost character of one OSM way, shared by all edges cut from it. */
export interface GraphWay {
  wayId: number;
  kind: PathKind;
  name: string | null;
  /** Tobler's speed multiplier for this way's surface and `sac_scale`. */
  terrainFactor: number;
  /** `KIND_PENALTY` for this way's kind. */
  penalty: number;
}

/**
 * Typed arrays with adjacency in compressed-sparse-row form: a county-sized graph is a few
 * hundred thousand edges, which as objects is tens of megabytes and a GC pause mid-drag.
 * Private to this module — nothing outside indexes these directly.
 */
export interface RouteGraph {
  /** Node positions, flattened `[lng, lat, …]`. */
  coords: Float64Array;
  /** Ground elevation per node, metres. */
  eleM: Float32Array;
  /** Edge endpoints, flattened `[a, b, …]`. Undirected; cost differs by direction. */
  edgeNodes: Int32Array;
  /** Index into `ways` per edge. */
  edgeWay: Int32Array;
  /** Horizontal ground length per edge, metres. */
  edgeLengthM: Float32Array;
  ways: GraphWay[];
  /** Edges touching node `n` are `adjEdges[adjStart[n]] … adjEdges[adjStart[n + 1] - 1]`. */
  adjStart: Int32Array;
  adjEdges: Int32Array;
  nodeCount: number;
  edgeCount: number;
}

/**
 * The position of a node. `!` on every typed-array read throughout this module:
 * `noUncheckedIndexedAccess` cannot tell a typed array from a sparse one, and the alternative
 * is a bounds test in a search's inner loop for something the buffer's length guarantees.
 */
export function graphNodeAt(graph: RouteGraph, node: number): LngLat {
  return [graph.coords[node * 2]!, graph.coords[node * 2 + 1]!];
}

/** The same key `assemble.ts` joins ways on: seven decimals is the precision OSM stores. */
function nodeKey(lng: number, lat: number): string {
  return `${lng.toFixed(7)},${lat.toFixed(7)}`;
}

/**
 * Segments in, searchable graph out. Duplicate edges are dropped, which is what lets partial
 * runs be cached per routing tile with no merging step: a way straddling two tiles arrives
 * twice with identical OSM coordinates, so the second copy produces the same node pairs.
 */
export function buildGraph(segments: readonly PathSegment[]): RouteGraph {
  const index = new Map<string, number>();
  const lngs: number[] = [];
  const lats: number[] = [];
  const eles: number[] = [];

  const nodeFor = (lng: number, lat: number, ele: number): number => {
    const key = nodeKey(lng, lat);
    const existing = index.get(key);
    if (existing !== undefined) return existing;
    const id = lngs.length;
    index.set(key, id);
    lngs.push(lng);
    lats.push(lat);
    eles.push(ele);
    return id;
  };

  const ways: GraphWay[] = [];
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const edgeW: number[] = [];
  const edgeL: number[] = [];
  const seen = new Set<number>();

  for (const segment of segments) {
    const count = Math.min(segment.coords.length >> 1, segment.eleM.length);
    if (count < 2) continue;

    const wayIndex = ways.length;
    ways.push({
      wayId: segment.wayId,
      kind: segment.kind,
      name: segment.name,
      terrainFactor: terrainFactorFor({ surface: segment.surface, sacScale: segment.sacScale }),
      penalty: KIND_PENALTY[segment.kind],
    });

    let prev = nodeFor(segment.coords[0]!, segment.coords[1]!, segment.eleM[0]!);
    let contributed = false;
    for (let i = 1; i < count; i++) {
      const node = nodeFor(segment.coords[i * 2]!, segment.coords[i * 2 + 1]!, segment.eleM[i]!);
      if (node === prev) continue;

      // Pairing on the ordered node pair gives one integer per undirected edge, so dedup is a
      // Set of numbers rather than of concatenated strings.
      const lo = Math.min(prev, node);
      const hi = Math.max(prev, node);
      const key = lo * 4_294_967_296 + hi;
      if (!seen.has(key)) {
        seen.add(key);
        edgeA.push(prev);
        edgeB.push(node);
        edgeW.push(wayIndex);
        edgeL.push(haversineM([lngs[prev]!, lats[prev]!], [lngs[node]!, lats[node]!]));
        contributed = true;
      }
      prev = node;
    }

    // Every edge was already present: the run is a tile overlap. Drop the way record too, or a
    // well-travelled boundary accumulates thousands of unreferenced ones.
    if (!contributed) ways.pop();
  }

  const nodeCount = lngs.length;
  const edgeCount = edgeA.length;

  const coords = new Float64Array(nodeCount * 2);
  const eleM = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    coords[i * 2] = lngs[i]!;
    coords[i * 2 + 1] = lats[i]!;
    eleM[i] = eles[i]!;
  }

  const edgeNodes = new Int32Array(edgeCount * 2);
  const edgeWay = new Int32Array(edgeCount);
  const edgeLengthM = new Float32Array(edgeCount);
  const degree = new Int32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    const a = edgeA[e]!;
    const b = edgeB[e]!;
    edgeNodes[e * 2] = a;
    edgeNodes[e * 2 + 1] = b;
    edgeWay[e] = edgeW[e]!;
    edgeLengthM[e] = edgeL[e]!;
    degree[a] = degree[a]! + 1;
    degree[b] = degree[b]! + 1;
  }

  // Prefix-sum the degrees into start offsets, then fill, using a moving cursor per node.
  const adjStart = new Int32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) adjStart[n + 1] = adjStart[n]! + degree[n]!;
  const cursor = adjStart.slice(0, nodeCount);
  const adjEdges = new Int32Array(edgeCount * 2);
  for (let e = 0; e < edgeCount; e++) {
    const a = edgeNodes[e * 2]!;
    const b = edgeNodes[e * 2 + 1]!;
    adjEdges[cursor[a]!] = e;
    cursor[a] = cursor[a]! + 1;
    adjEdges[cursor[b]!] = e;
    cursor[b] = cursor[b]! + 1;
  }

  return {
    coords,
    eleM,
    edgeNodes,
    edgeWay,
    edgeLengthM,
    ways,
    adjStart,
    adjEdges,
    nodeCount,
    edgeCount,
  };
}

export interface SnapResult {
  node: number;
  point: LngLat;
  /** How far the click was from the network, metres. */
  distanceM: number;
}

/**
 * The node nearest a clicked point, or null if the click was nowhere near a path. Linear over
 * the node array: a viewport-sized graph is tens of thousands of nodes and this runs once per
 * click. If planning ever spans a whole country, a spatial index is the first thing to add.
 */
export function snapToGraph(
  graph: RouteGraph,
  point: LngLat,
  maxDistanceM = DEFAULT_SNAP_RADIUS_M,
): SnapResult | null {
  if (graph.nodeCount === 0) return null;

  // Compare in a locally-flat plane scaled by cos(lat): monotonic in true distance, so it picks
  // the same winner as haversine. The winner alone is then measured properly.
  const [lng, lat] = point;
  const kx = Math.cos((lat * Math.PI) / 180);

  let best = -1;
  let bestScore = Infinity;
  for (let n = 0; n < graph.nodeCount; n++) {
    const dx = (graph.coords[n * 2]! - lng) * kx;
    const dy = graph.coords[n * 2 + 1]! - lat;
    const score = dx * dx + dy * dy;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }

  if (best < 0) return null;
  const at = graphNodeAt(graph, best);
  const distanceM = haversineM(point, at);
  return distanceM > maxDistanceM ? null : { node: best, point: at, distanceM };
}

/**
 * What to optimise for. Deliberately not extending `PaceOptions`: a pace factor and a global
 * terrain override scale every edge by the same constant, so they cannot change which route is
 * cheapest. Pace belongs on the finished line, via `estimateMovingTimeS`.
 */
export interface RouteCostOptions {
  /**
   * Set false to route purely by time, ignoring `KIND_PENALTY`. On by default because
   * "fastest" and "nicest" differ, and a hiking planner should default to nicest.
   */
  preferPaths?: boolean;
}

/** One traversal's cost in seconds at pace 1, in the given direction. */
function edgeSeconds(
  graph: RouteGraph,
  edge: number,
  from: number,
  to: number,
  prefer: boolean,
): number {
  const run = graph.edgeLengthM[edge]!;
  if (run <= 0) return 0;
  const way = graph.ways[graph.edgeWay[edge]!]!;
  const rise = graph.eleM[to]! - graph.eleM[from]!;
  const speedKmh = toblerSpeedKmh(rise / run) * way.terrainFactor;
  const seconds = (run / 1000 / speedKmh) * 3600;
  return prefer ? seconds * way.penalty : seconds;
}

/**
 * Straight-line seconds to the goal at the fastest speed anything can be hiked. Admissible by
 * construction: great-circle distance never exceeds along-ground distance, `MAX_HIKE_SPEED_KMH`
 * bounds every edge's Tobler-times-terrain speed, and every penalty is ≥ 1.
 */
function heuristicS(graph: RouteGraph, node: number, goal: LngLat): number {
  const metres = haversineM(graphNodeAt(graph, node), goal);
  return (metres / 1000 / MAX_HIKE_SPEED_KMH) * 3600;
}

/**
 * A binary min-heap keyed by f-score. Written out because the alternative in a dependency-light
 * package is re-sorting an array on every push, which makes an O(E log V) search quadratic.
 */
class MinHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.keys[left]! < this.keys[smallest]!) smallest = left;
        if (right < this.items.length && this.keys[right]! < this.keys[smallest]!) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}

export interface GraphPath {
  /** Node indices from start to goal inclusive. */
  nodes: number[];
  /** How many nodes the search settled. Diagnostic; the UI never shows it. */
  visited: number;
}

/**
 * A* from one node to another, minimising hiking time. Null means the two are in different
 * components — a real answer, not a failure; the planner offers a freehand leg rather than
 * inventing a link.
 */
export function findPath(
  graph: RouteGraph,
  start: number,
  goal: number,
  options: RouteCostOptions = {},
): GraphPath | null {
  if (start === goal) return { nodes: [start], visited: 0 };
  if (start < 0 || goal < 0 || start >= graph.nodeCount || goal >= graph.nodeCount) return null;

  const prefer = options.preferPaths ?? true;
  const goalAt = graphNodeAt(graph, goal);

  const gScore = new Float64Array(graph.nodeCount).fill(Infinity);
  const cameFrom = new Int32Array(graph.nodeCount).fill(-1);
  const closed = new Uint8Array(graph.nodeCount);
  const open = new MinHeap();

  gScore[start] = 0;
  open.push(start, heuristicS(graph, start, goalAt));

  let visited = 0;
  while (open.size > 0) {
    const current = open.pop()!;
    if (closed[current]) continue;
    closed[current] = 1;
    visited++;

    if (current === goal) {
      const nodes: number[] = [];
      for (let n = goal; n !== -1; n = cameFrom[n]!) nodes.push(n);
      nodes.reverse();
      return { nodes, visited };
    }

    for (let i = graph.adjStart[current]!; i < graph.adjStart[current + 1]!; i++) {
      const edge = graph.adjEdges[i]!;
      const a = graph.edgeNodes[edge * 2]!;
      const next = a === current ? graph.edgeNodes[edge * 2 + 1]! : a;
      if (closed[next]) continue;

      const tentative = gScore[current]! + edgeSeconds(graph, edge, current, next, prefer);
      if (tentative >= gScore[next]!) continue;
      gScore[next] = tentative;
      cameFrom[next] = current;
      open.push(next, tentative + heuristicS(graph, next, goalAt));
    }
  }

  return null;
}

/**
 * The path as ground: coordinates and elevations, ready to become a profile. Deliberately no
 * length, gain or time — those come from `profileFromLine` and `estimateMovingTimeS`, the same
 * functions the trail pipeline uses, so a planned route and an ingested trail of identical
 * shape report identical numbers.
 */
export function pathGeometry(
  graph: RouteGraph,
  path: GraphPath,
): { coords: LngLat[]; eleM: number[] } {
  const coords: LngLat[] = [];
  const eleM: number[] = [];
  for (const node of path.nodes) {
    coords.push(graphNodeAt(graph, node));
    eleM.push(graph.eleM[node]!);
  }
  return { coords, eleM };
}
