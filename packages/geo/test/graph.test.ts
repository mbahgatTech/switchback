import { describe, expect, it } from 'vitest';
import type { PathKind, PathSegment } from '@switchback/core';
import {
  DEFAULT_SNAP_RADIUS_M,
  KIND_PENALTY,
  MAX_HIKE_SPEED_KMH,
  buildGraph,
  findPath,
  graphNodeAt,
  haversineM,
  pathGeometry,
  snapToGraph,
  toblerSpeedKmh,
} from '@switchback/geo';

/**
 * A synthetic network built in degrees near the equator, where a degree of longitude and a
 * degree of latitude are close enough to the same length that "which of these two routes is
 * longer" is answerable by eye. Every fixture below is small enough to reason about by hand,
 * which is the point — a routing test that needs its own routing engine to state the
 * expected answer proves nothing.
 */
function seg(
  wayId: number,
  points: readonly (readonly [number, number, number])[],
  extra: Partial<Omit<PathSegment, 'wayId' | 'coords' | 'eleM'>> = {},
): PathSegment {
  return {
    wayId,
    kind: 'path',
    name: null,
    surface: null,
    sacScale: null,
    coords: points.flatMap(([lng, lat]) => [lng, lat]),
    eleM: points.map(([, , ele]) => ele),
    ...extra,
  };
}

/** A flat two-vertex way from `a` to `b`, at a thousandth of a degree per step. */
function flat(
  wayId: number,
  a: readonly [number, number],
  b: readonly [number, number],
  kind?: PathKind,
) {
  return seg(
    wayId,
    [
      [a[0], a[1], 0],
      [b[0], b[1], 0],
    ],
    kind ? { kind } : {},
  );
}

describe('buildGraph', () => {
  it('interns a shared coordinate as one node, joining two ways into one network', () => {
    // An L: east along the bottom, then north from the corner.
    const graph = buildGraph([flat(1, [0, 0], [0.01, 0]), flat(2, [0.01, 0], [0.01, 0.01])]);

    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(2);
    // The corner carries both edges; the two ends carry one each.
    expect(graph.adjStart[3]! - graph.adjStart[0]!).toBe(4);
  });

  it('does not join two ways that merely pass close by — a bridge over a path', () => {
    // A metre apart at the crossing, which is what a footbridge and the path beneath it
    // actually measure. Welding these would route a hiker off the side of a bridge.
    const under = flat(1, [0, 0], [0.01, 0]);
    const over = seg(2, [
      [0.005, -0.001, 4],
      [0.005, 0.001, 4],
    ]);
    const graph = buildGraph([under, over]);

    expect(graph.nodeCount).toBe(4);
    expect(findPath(graph, 0, 2)).toBeNull();
  });

  it('discards the duplicate stretch when two routing tiles cached the same way', () => {
    const a = seg(1, [
      [0, 0, 0],
      [0.01, 0, 0],
      [0.02, 0, 0],
    ]);
    // The neighbouring tile's copy: same OSM way, same node coordinates, overlapping run.
    const b = seg(1, [
      [0.01, 0, 0],
      [0.02, 0, 0],
      [0.03, 0, 0],
    ]);
    const graph = buildGraph([a, b]);

    expect(graph.nodeCount).toBe(4);
    expect(graph.edgeCount).toBe(3);
  });

  it('drops the way record when a run contributed nothing but duplicates', () => {
    const run = seg(1, [
      [0, 0, 0],
      [0.01, 0, 0],
    ]);
    const graph = buildGraph([run, { ...run }]);

    expect(graph.edgeCount).toBe(1);
    expect(graph.ways).toHaveLength(1);
  });

  it('skips repeated vertices rather than emitting a zero-length edge', () => {
    const graph = buildGraph([
      seg(1, [
        [0, 0, 0],
        [0, 0, 0],
        [0.01, 0, 0],
      ]),
    ]);

    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
  });

  it('ignores a run too short to be an edge', () => {
    expect(buildGraph([seg(1, [[0, 0, 0]])]).edgeCount).toBe(0);
    expect(buildGraph([]).nodeCount).toBe(0);
  });

  it('measures edge length on the ground, not in degrees', () => {
    const graph = buildGraph([flat(1, [0, 0], [0.01, 0])]);
    const expected = haversineM([0, 0], [0.01, 0]);

    expect(graph.edgeLengthM[0]).toBeCloseTo(expected, 1);
  });

  it('carries surface and sac_scale into the way as a terrain factor', () => {
    const graph = buildGraph([
      seg(
        1,
        [
          [0, 0, 0],
          [0.01, 0, 0],
        ],
        { surface: 'scree', sacScale: 'demanding_mountain_hiking' },
      ),
    ]);

    expect(graph.ways[0]!.terrainFactor).toBeLessThan(1);
    expect(graph.ways[0]!.penalty).toBe(KIND_PENALTY.path);
  });
});

describe('graphNodeAt', () => {
  it('returns the coordinate the segment was built from', () => {
    const graph = buildGraph([flat(1, [-115.66782, 50.87833], [-115.65782, 50.87833])]);

    const [lng, lat] = graphNodeAt(graph, 0);
    expect(lng).toBeCloseTo(-115.66782, 7);
    expect(lat).toBeCloseTo(50.87833, 7);
  });
});

describe('snapToGraph', () => {
  const graph = buildGraph([flat(1, [0, 0], [0.01, 0])]);

  it('finds the nearest node and reports how far off the network the click was', () => {
    // A shade past the far end, so the second node wins.
    const hit = snapToGraph(graph, [0.0102, 0]);

    expect(hit?.node).toBe(1);
    expect(hit?.point[0]).toBeCloseTo(0.01, 7);
    expect(hit?.distanceM).toBeCloseTo(haversineM([0.0102, 0], [0.01, 0]), 1);
  });

  it('returns null when the click is beyond the snap radius', () => {
    expect(snapToGraph(graph, [0, 0.02])).toBeNull();
  });

  it('honours a caller-supplied radius', () => {
    const far: [number, number] = [0, 0.005];
    expect(snapToGraph(graph, far, 100)).toBeNull();
    expect(snapToGraph(graph, far, 1000)?.node).toBe(0);
  });

  it('returns null on an empty graph rather than throwing', () => {
    expect(snapToGraph(buildGraph([]), [0, 0])).toBeNull();
  });

  it('picks the true nearest across a wide longitude span, not the nearest in degrees', () => {
    // At 60°N a degree of longitude is half a degree of latitude on the ground. A snap that
    // compared raw degrees would pick the eastern node; the cos(lat) scaling picks the
    // northern one, which is genuinely closer.
    const high = buildGraph([flat(1, [0, 60], [0.0018, 60]), flat(2, [0, 60], [0, 60.0006])]);
    const hit = snapToGraph(high, [0, 60.0006]);

    expect(hit?.distanceM).toBeCloseTo(0, 3);
  });

  it('has a default radius wide enough to forgive a fat finger', () => {
    expect(DEFAULT_SNAP_RADIUS_M).toBeGreaterThanOrEqual(50);
  });
});

describe('findPath', () => {
  /**
   * A ladder: two parallel east-west lines joined at both ends and in the middle. The
   * northern rail is a road, the southern a path, so preference has something to choose.
   *
   *   (0,0.001) ──road── (0.005,0.001) ──road── (0.01,0.001)
   *      │                    │                     │
   *   (0,0)     ──path── (0.005,0)     ──path── (0.01,0)
   */
  function ladder() {
    return buildGraph([
      flat(1, [0, 0], [0.005, 0]),
      flat(2, [0.005, 0], [0.01, 0]),
      flat(3, [0, 0.001], [0.005, 0.001], 'road'),
      flat(4, [0.005, 0.001], [0.01, 0.001], 'road'),
      flat(5, [0, 0], [0, 0.001]),
      flat(6, [0.005, 0], [0.005, 0.001]),
      flat(7, [0.01, 0], [0.01, 0.001]),
    ]);
  }

  it('walks the direct line between two nodes on one way', () => {
    const graph = buildGraph([
      seg(1, [
        [0, 0, 0],
        [0.005, 0, 0],
        [0.01, 0, 0],
      ]),
    ]);
    const path = findPath(graph, 0, 2);

    expect(path?.nodes).toEqual([0, 1, 2]);
  });

  it('costs by Tobler over the horizontal run, so it climbs the long way round', () => {
    // Two routes to the same summit node. The direct one is 400 m at a punishing 50 %; the
    // dog-leg is 1,200 m at a walkable 17 %. Tobler makes the long way faster (≈1,537 s
    // against ≈1,643 s) — a router costing by distance would send someone up the wall.
    const graph = buildGraph([
      seg(1, [
        [0, 0, 0],
        [0.0036, 0, 200],
      ]),
      seg(2, [
        [0, 0, 0],
        [0, 0.0036, 66.7],
        [0.0036, 0.0036, 133.3],
        [0.0036, 0, 200],
      ]),
    ]);
    const goal = snapToGraph(graph, [0.0036, 0])!.node;
    const path = findPath(graph, 0, goal)!;

    expect(path.nodes).toHaveLength(4);
    const { eleM } = pathGeometry(graph, path);
    expect(eleM[0]).toBe(0);
    expect(eleM[1]).toBeCloseTo(66.7, 1);
    expect(eleM[3]).toBe(200);
  });

  it('prefers the path rail over the faster road rail', () => {
    const graph = ladder();
    const start = snapToGraph(graph, [0, 0])!.node;
    const goal = snapToGraph(graph, [0.01, 0])!.node;

    const path = findPath(graph, start, goal);
    const onPath = path!.nodes.map((n) => graphNodeAt(graph, n)[1]);

    // Never leaves the southern rail, even though tarmac is quicker underfoot.
    expect(onPath.every((lat) => Math.abs(lat) < 1e-9)).toBe(true);
  });

  it('switches to the road only when told to ignore preference', () => {
    // The path rail crosses an 80 m hummock; the road rail is flat asphalt but 220 m longer.
    // On the clock the road wins (≈916 s against ≈1,121 s). With the kind penalty applied it
    // loses badly (≈1,446 s). One graph, two defensible answers, and the default is the one
    // a hiker wants.
    const graph = buildGraph([
      seg(1, [
        [0, 0, 0],
        [0.005, 0, 80],
        [0.01, 0, 0],
      ]),
      flat(2, [0, 0], [0, 0.001]),
      seg(
        3,
        [
          [0, 0.001, 0],
          [0.01, 0.001, 0],
        ],
        { kind: 'road', surface: 'asphalt' },
      ),
      flat(4, [0.01, 0.001], [0.01, 0]),
    ]);
    const start = snapToGraph(graph, [0, 0])!.node;
    const goal = snapToGraph(graph, [0.01, 0])!.node;
    const northOf = (path: NonNullable<ReturnType<typeof findPath>>) =>
      path.nodes.some((n) => graphNodeAt(graph, n)[1] > 0);

    expect(northOf(findPath(graph, start, goal, { preferPaths: false })!)).toBe(true);
    expect(northOf(findPath(graph, start, goal)!)).toBe(false);
  });

  it('returns null between two disconnected components', () => {
    const graph = buildGraph([flat(1, [0, 0], [0.01, 0]), flat(2, [1, 1], [1.01, 1])]);

    expect(findPath(graph, 0, 2)).toBeNull();
  });

  it('returns a single-node path when start and goal are the same node', () => {
    const graph = buildGraph([flat(1, [0, 0], [0.01, 0])]);

    expect(findPath(graph, 0, 0)).toEqual({ nodes: [0], visited: 0 });
  });

  it('returns null for node indices outside the graph', () => {
    const graph = buildGraph([flat(1, [0, 0], [0.01, 0])]);

    expect(findPath(graph, -1, 1)).toBeNull();
    expect(findPath(graph, 0, 99)).toBeNull();
  });

  it('finds the optimum, not merely a route — the detour is never taken', () => {
    // Two ways from west to east: a straight one and a dog-leg through the north. Both are
    // paths, so only distance separates them. An inadmissible heuristic would sometimes
    // settle for the dog-leg; this asserts it never does.
    const graph = buildGraph([
      flat(1, [0, 0], [0.01, 0]),
      flat(2, [0, 0], [0.005, 0.004]),
      flat(3, [0.005, 0.004], [0.01, 0]),
    ]);
    const goal = snapToGraph(graph, [0.01, 0])!.node;

    expect(findPath(graph, 0, goal)!.nodes).toHaveLength(2);
  });

  it('settles fewer nodes than the graph holds — the heuristic is doing work', () => {
    // A long east-west corridor with a dead-end spur hanging off every vertex. A blind
    // Dijkstra sweep would settle the spurs too; A* aimed at the far end mostly should not.
    const segments: PathSegment[] = [];
    for (let i = 0; i < 40; i++) {
      segments.push(flat(i + 1, [i * 0.001, 0], [(i + 1) * 0.001, 0]));
      segments.push(flat(100 + i, [i * 0.001, 0], [i * 0.001, -0.002]));
    }
    const graph = buildGraph(segments);
    const goal = snapToGraph(graph, [0.04, 0])!.node;
    const path = findPath(graph, 0, goal)!;

    expect(path.nodes).toHaveLength(41);
    expect(path.visited).toBeLessThan(graph.nodeCount);
  });
});

describe('pathGeometry', () => {
  it('returns one coordinate and one elevation per node, in order', () => {
    const graph = buildGraph([
      seg(1, [
        [0, 0, 10],
        [0.005, 0, 30],
        [0.01, 0, 20],
      ]),
    ]);
    const { coords, eleM } = pathGeometry(graph, findPath(graph, 0, 2)!);

    expect(coords).toHaveLength(3);
    expect(coords[1]![0]).toBeCloseTo(0.005, 7);
    expect(eleM).toEqual([10, 30, 20]);
  });
});

describe('MAX_HIKE_SPEED_KMH', () => {
  it('is a true upper bound on every speed the cost model can produce', () => {
    // The admissibility proof in one assertion. If someone adds a surface faster than
    // tarmac and forgets this, A* stops returning optima — silently, which is the worst
    // way for a router to be wrong.
    const fastest = toblerSpeedKmh(-0.05) * 1.05;

    expect(MAX_HIKE_SPEED_KMH).toBeGreaterThanOrEqual(fastest - 1e-9);
  });
});

describe('KIND_PENALTY', () => {
  it('never makes a way faster, only less attractive', () => {
    for (const penalty of Object.values(KIND_PENALTY)) expect(penalty).toBeGreaterThanOrEqual(1);
  });

  it('ranks a footpath above a road by a wide margin', () => {
    expect(KIND_PENALTY.path).toBeLessThan(KIND_PENALTY.road);
    expect(KIND_PENALTY.road / KIND_PENALTY.path).toBeGreaterThan(1.5);
  });
});
