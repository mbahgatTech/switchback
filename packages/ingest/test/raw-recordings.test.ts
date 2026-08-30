/**
 * The recording set: complete against the query builders in source, consistent with the files on
 * disk, and every answer held to what its own consumer makes of it.
 */

import { describe, expect, it } from 'vitest';
import { osmKey } from '../../db/scripts/peak-elevations';
import { classifyWaypoint, parseEleM } from '../src/enrich';
import { countNodes, waysToSegments } from '../src/network';
import type { OverpassElement, OverpassRelation } from '../src/overpass';
import { pickRegion } from '../src/tile-context';
import { overpassShapesInSource } from './support/query-builders';
import {
  DENSE_TILE,
  RAW_SHAPES,
  SPARSE_TILE,
  assembleSummary,
  buildRawIndex,
  loadRawFixture,
  loadRawIndex,
  type RawShape,
} from './support/raw-fixture';

function elementsOf(shape: RawShape, subject: string): OverpassElement[] {
  return loadRawFixture(shape, subject).response.elements ?? [];
}

describe('the recording index', () => {
  /**
   * Rebuilt from the recordings themselves rather than compared to a list, so a recording added,
   * re-recorded or deleted without rebuilding the index is a difference rather than a stale row
   * agreeing with itself.
   */
  it('is what rebuilding it from the files on disk produces', () => {
    expect(loadRawIndex()).toEqual(buildRawIndex());
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
   * Read off the query builders in source rather than listed here, so a builder added anywhere is
   * one this notices has no recording — including a `RAW_SHAPES` that has stopped keeping up.
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
  it('parses to the segments and nodes a routing tile is stored as', () => {
    const segments = waysToSegments(elementsOf('network', '021231030323'));

    // Every element classifies: `waysToSegments` drops nothing from this answer.
    expect(segments).toHaveLength(282);
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
    const elements = elementsOf('route', '1225378');
    const superroute = elements.find(
      (element): element is OverpassRelation => element.type === 'relation',
    )!;
    const members = superroute.members ?? [];

    expect(superroute.tags?.type).toBe('superroute');
    expect(members.filter((member) => member.type === 'relation')).toHaveLength(29);
    expect(members.some((member) => member.geometry)).toBe(false);
    expect(assembleSummary(elements)).toEqual([]);
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
  const counted: Record<string, number> = {};
  for (const element of elements) {
    const kind = classifyWaypoint(element.tags ?? {});
    if (kind) counted[kind] = (counted[kind] ?? 0) + 1;
  }
  return counted;
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
