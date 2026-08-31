/**
 * The recording set: complete against the query builders in source, consistent with the files on
 * disk, and every answer held to what its own consumer makes of it.
 */

import { describe, expect, it } from 'vitest';
import { osmKey } from '../../db/scripts/peak-elevations';
import { classifyWaypoint, parseEleM } from '../src/enrich';
import { countNodes, waysToSegments } from '../src/network';
import type { OverpassElement, OverpassRelation, OverpassWay } from '../src/overpass';
import { pickRegion } from '../src/tile-context';
import { SOURCE_SCAN_TIMEOUT_MS, overpassShapesInSource } from './support/query-builders';
import {
  DENSE_TILE,
  RAW_SHAPES,
  RECORDING_SET_TIMEOUT_MS,
  SPARSE_TILE,
  buildRawIndex,
  loadRawFixture,
  loadRawIndex,
  summariseRecording,
  type RawShape,
} from './support/raw-fixture';

function elementsOf(shape: RawShape, subject: string): OverpassElement[] {
  return loadRawFixture(shape, subject).response.elements ?? [];
}

/** A distribution rather than a total, so a reclassification is a diff and not a coincidence. */
function countBy<T>(items: readonly T[], of: (item: T) => string | null): Record<string, number> {
  const counted: Record<string, number> = {};
  for (const item of items) {
    const key = of(item);
    if (key !== null) counted[key] = (counted[key] ?? 0) + 1;
  }
  return counted;
}

/**
 * Both kinds of work in the block below run past vitest's 5 s default — the recordings are
 * gunzipped whole, and every non-test source is walked — so it takes the larger of their budgets.
 * On the block rather than on each test: a case added beside them inherits it rather than omits it.
 */
const RECORDING_INDEX_TIMEOUT_MS = Math.max(RECORDING_SET_TIMEOUT_MS, SOURCE_SCAN_TIMEOUT_MS);

describe('the recording index', { timeout: RECORDING_INDEX_TIMEOUT_MS }, () => {
  /**
   * Rebuilt from the recordings themselves rather than compared to a list, so a recording added,
   * re-recorded or deleted without rebuilding the index is a difference rather than a stale row
   * agreeing with itself.
   */
  it('is what rebuilding it from the files on disk produces', () => {
    expect(loadRawIndex()).toEqual(buildRawIndex());
  });

  /**
   * What the runner gives a case that states no budget of its own, which is what the block gives
   * every case in it. Dropped from the `describe`, this block is back on the 5 s default that
   * timed the rebuild above out on a tree nothing had changed.
   */
  it('budgets a case that states none for the work in this block', ({ task }) => {
    expect(task.timeout).toBe(RECORDING_INDEX_TIMEOUT_MS);
  });

  /**
   * The instant of the planet each answer describes. Without it a fixture is undated — the
   * request time says only when it was asked for, not how far behind the mirror was.
   */
  it('pins an OSM base timestamp on every recording', () => {
    for (const entry of loadRawIndex()) {
      expect(String(entry.timestampOsmBase), entry.file).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
      );
    }
  });

  /**
   * Read off the query builders in source rather than listed here, so a query written in any
   * non-test file — under a `class` or an `export default` as much as a top-level `const` — is
   * one this notices has no recording, including a `RAW_SHAPES` that has stopped keeping up.
   */
  it('covers every Overpass answer the repository asks for', async () => {
    const asked = await overpassShapesInSource();

    expect([...new Set(loadRawIndex().map((entry) => entry.shape))].sort()).toEqual(asked);
    expect([...RAW_SHAPES].sort()).toEqual(asked);
  });
});

describe('the region answer', () => {
  /** `pickRegion` prefers the most local level present; level 2 is read only for its ISO code. */
  it('names the county and country the sparse tile sits in', () => {
    expect(pickRegion(elementsOf('region', SPARSE_TILE))).toEqual({
      regionName: 'Kootenai County',
      countryCode: 'US',
    });
  });
});

describe('the network answer', () => {
  const elements = elementsOf('network', '021231030323');
  const ways = elements.filter((element): element is OverpassWay => element.type === 'way');
  const segments = waysToSegments(elements);

  /**
   * Read off the recording rather than counted from it: `buildNetworkQuery`'s server-side
   * filters and `classifyWay` agree about this box, and no way in it has a hole, so each way
   * becomes exactly one segment and arrives in the order the answer listed it.
   */
  it('keeps every way in the answer, unsplit and in order', () => {
    expect(segments.map((segment) => segment.wayId)).toEqual(ways.map((way) => way.id));
  });

  /**
   * The cost model the router prices paths with, and the only reason this recording carries
   * tags. A `HIGHWAY_KIND` entry retargeted or a `surface` dropped re-prices every route and
   * leaves the segment count untouched. Nothing in this box carries `sac_scale`, so grade is
   * covered by the synthetic cases in `network.test.ts` alone.
   */
  it('classifies into the kinds, surfaces and names routing reads', () => {
    expect(countBy(segments, (segment) => segment.kind)).toEqual({
      cycleway: 12,
      footway: 3,
      path: 9,
      road: 245,
      track: 13,
    });
    expect(countBy(segments, (segment) => segment.surface)).toEqual({
      asphalt: 20,
      gravel: 4,
      paved: 6,
      wood: 1,
    });

    const named = segments.filter((segment) => segment.name !== null);
    expect(named).toHaveLength(158);
    expect(new Set(named.map((segment) => segment.name)).size).toBe(123);
  });

  /** `countNodes` fuses the coordinate two ways share, which is what makes a junction one. */
  it('fuses coordinates shared between ways into one graph vertex', () => {
    expect(countNodes(segments)).toBe(6_089);
  });
});

describe('the tags-by-id answer', () => {
  /** What `backfill-peak-elevations` reads out of it: one height per element key, nothing else. */
  it('yields a height for each of the twelve peaks', () => {
    const heights = Object.fromEntries(
      elementsOf('tags-by-id', 'node.12').map((element) => [
        osmKey('node', element.id),
        parseEleM(element.tags?.ele),
      ]),
    );

    expect(heights).toEqual({
      'node/357923292': 1589,
      'node/358653835': 1285,
      'node/358653933': 1440,
      'node/358654197': 1894,
      'node/358654224': 1566,
      'node/358654634': 1430,
      'node/358654655': 1202,
      'node/358654662': 1445,
      'node/358654769': 1218,
      'node/358654828': 1251,
      'node/358654832': 1501,
      'node/358654914': 1710,
    });
  });
});

describe('the Pacific Crest Trail superroute', () => {
  /**
   * A superroute's members are relations, which `out body geom` returns without geometry, so
   * assembly makes nothing of it. That is the whole reason `parent-route` is a separate query.
   */
  it('assembles to nothing, because its members are relations', () => {
    const recording = loadRawFixture('route', '1225378');
    const superroute = (recording.response.elements ?? []).find(
      (element): element is OverpassRelation => element.type === 'relation',
    )!;
    const members = superroute.members ?? [];

    expect(superroute.tags?.type).toBe('superroute');
    expect(members.filter((member) => member.type === 'relation')).toHaveLength(29);
    expect(members.some((member) => member.geometry)).toBe(false);
    expect(summariseRecording(recording)).toEqual([]);
  });
});

describe('the parent-route answer', () => {
  /**
   * `relation(bbox)` does not recurse into member relations, so no tile query can see the Pacific
   * Crest Trail — only its sections. This recording is the proof that `rel(br)` does.
   */
  it('names the superroute that contains two PCT sections', () => {
    const parents = elementsOf('parent-route', '1247934+1249228').filter(
      (element): element is OverpassRelation => element.type === 'relation',
    );

    expect(parents.map((parent) => [parent.id, parent.tags?.type, parent.tags?.name])).toEqual([
      [1_225_378, 'superroute', 'Pacific Crest Trail'],
    ]);
  });
});

/** The waypoint kinds `attachWaypoints` would pull out of an answer, counted by kind. */
function waypointKinds(elements: readonly OverpassElement[]): Record<string, number> {
  return countBy(elements, (element) => classifyWaypoint(element.tags ?? {}));
}

const featureCases = [
  {
    density: 'sparse',
    quadkey: SPARSE_TILE,
    kinds: {
      campsite: 14,
      ford: 22,
      gate: 218,
      parking: 145,
      pass: 12,
      shelter: 5,
      summit: 97,
      toilets: 25,
      viewpoint: 7,
      water: 13,
    },
  },
  {
    density: 'dense',
    quadkey: DENSE_TILE,
    kinds: {
      campsite: 61,
      ford: 487,
      gate: 15_061,
      hazard: 3,
      junction: 163,
      parking: 13_168,
      pass: 6,
      shelter: 51,
      summit: 225,
      toilets: 665,
      viewpoint: 169,
      water: 818,
      waterfall: 17,
    },
  },
];

describe.each(featureCases)('the $density feature answer', ({ quadkey, kinds }) => {
  /**
   * Held to the classification rather than the element count, because a rule reordered in
   * `WAYPOINT_RULES` steals from a narrower one below it and changes nothing else observable.
   */
  it('classifies into the waypoint kinds enrichment attaches', () => {
    expect(waypointKinds(elementsOf('feature', quadkey))).toEqual(kinds);
  });
});
