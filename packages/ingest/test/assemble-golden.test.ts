/**
 * `assembleTrails` held to what it makes of recorded Overpass answers, so a change of trail
 * source is a diff rather than a surprise. The synthetic cases in `assemble.test.ts` are
 * collinear two-vertex ways sharing endpoints exactly, which never reach the gap bridging, the
 * spur discard or the tag vote — measurably so: `DEFAULT_GAP_TOLERANCE_M` can be changed from
 * 40 to 4 with all eighteen of them still green.
 */

import { describe, expect, it } from 'vitest';
import { assembleTrails } from '../src/assemble';
import type { OverpassQuerier, OverpassRelation } from '../src/overpass';
import { fetchRelationInParts } from '../src/pipeline';
import {
  RAW_SHAPES,
  assembleSummary,
  loadAssembleGolden,
  loadRawFixture,
  loadRawIndex,
  type AssembledTrailSummary,
} from './support/raw-fixture';

const SPARSE = '021231030';
const DENSE = '023010230';

/** Trail A: 9,081.9 m over three chained ways, of seven the relation declares. */
const TRAIL_A = 7470475;

/** A recorded tile, what assembly makes of it now, and what it is held to. */
function tileCase(density: string, quadkey: string, count: number) {
  return {
    density,
    count,
    trails: assembleSummary(loadRawFixture('tile', quadkey).response.elements ?? []),
    golden: loadAssembleGolden('tile', quadkey),
  };
}

const sparse = tileCase('sparse', SPARSE, 145);
const dense = tileCase('dense', DENSE, 1_517);

/** Identity and the two measurements a divergence shows up in first. */
function measured(trails: readonly AssembledTrailSummary[]): unknown[] {
  return trails.map((trail) => ({
    id: `${trail.osmType}/${trail.osmId}`,
    lengthM: trail.lengthM,
    bridgedM: trail.bridgedM,
  }));
}

describe.each([sparse, dense])('the $density tile', ({ trails, golden, count }) => {
  it('assembles to the committed golden', () => {
    // The count first: an empty recording and an empty golden compare equal.
    expect(trails).toHaveLength(count);
    expect(trails).toEqual(golden.trails);
  });

  /**
   * Length alone, so a geometry divergence names itself. Moving one member way 60 m breaks the
   * chain at a shared node and `pickPrimary` keeps the longer half — the trail survives, under
   * its own name, at a fraction of its length, and only this says so.
   */
  it('holds every trail to its recorded length and bridged distance', () => {
    expect(measured(trails)).toEqual(measured(golden.trails));
  });
});

describe('the default gap tolerance', () => {
  /**
   * The gap bridging is what `assemble.test.ts` cannot reach, because every way in it shares
   * its neighbour's endpoint exactly. Two trails in the sparse tile are joined across real
   * gaps, both inside the 40 m default and both far outside the 1 cm that counts as a shared
   * node, so dropping the default to 4 m changes them and this goes red.
   */
  it('bridges the gaps in the sparse tile that no synthetic case reaches', () => {
    const bridged = sparse.trails.filter((trail) => trail.bridgedM > 0);

    expect(bridged.map((trail) => trail.name)).toEqual(['Trail 8', 'Trail 10']);
    expect(bridged[0]!.bridgedM).toBeCloseTo(34.2, 1);
    expect(bridged[1]!.bridgedM).toBeCloseTo(24.1, 1);
  });
});

describe('a relation rebuilt from its parts', () => {
  /** The recorded skeleton and way geometry, served the way a mirror would serve them. */
  const overpass: OverpassQuerier = {
    query: (ql: string) =>
      Promise.resolve(
        ql.includes('way(id:')
          ? loadRawFixture('way-geometry', String(TRAIL_A)).response
          : loadRawFixture('relation-skeleton', String(TRAIL_A)).response,
      ),
  };

  /**
   * `fetchRelationInParts` claims its splice is structurally identical to what `out body geom`
   * would have returned. Both answers are recorded, so the claim is checked rather than
   * repeated — and it is checked through assembly, which is what the claim is *for*.
   */
  it('assembles identically to the same relation fetched whole', async () => {
    const rebuilt = await fetchRelationInParts(
      TRAIL_A,
      { overpass },
      () => {},
      0,
      new Error('mirror refused the relation whole'),
    );
    const whole = loadRawFixture('route', String(TRAIL_A)).response.elements ?? [];

    expect(assembleSummary([rebuilt])).toEqual(assembleSummary(whole));
    expect(assembleSummary([rebuilt])[0]!.lengthM).toBeCloseTo(9_081.9, 1);
  });
});

describe('the parent route lookup', () => {
  /**
   * `relation(bbox)` does not recurse into member relations, so no tile query can see the
   * Pacific Crest Trail — only its sections. This recording is the proof that `rel(br)` does.
   */
  it('names the superroute that contains two PCT sections', () => {
    const parents = (
      loadRawFixture('parent-route', '1247934+1249228').response.elements ?? []
    ).filter((element): element is OverpassRelation => element.type === 'relation');

    expect(parents.map((parent) => [parent.id, parent.tags?.type, parent.tags?.name])).toEqual([
      [1_225_378, 'superroute', 'Pacific Crest Trail'],
    ]);
  });
});

describe('a member way with a hole in it', () => {
  /**
   * A missing position is a truncated response, not a clipped way, and interpolating across it
   * would invent geometry. Trail A is three chained ways; holing the last drops it and leaves
   * the two that still chain, so the trail shortens to 4,983.9 m rather than keeping its
   * length across a span nobody surveyed.
   */
  it('is dropped rather than assembled across', () => {
    const relation = structuredClone(
      (loadRawFixture('route', String(TRAIL_A)).response.elements ?? []).find(
        (element): element is OverpassRelation => element.type === 'relation',
      )!,
    );
    const holed = relation.members?.find((member) => member.ref === 35_744_293);
    delete (holed?.geometry as unknown as Array<{ lat?: number }>)[5]!.lat;

    const [trail] = assembleTrails([relation]);

    expect(trail!.memberWayIds).toEqual([36_925_943, 35_744_292]);
    expect(trail!.lengthM).toBeCloseTo(4_983.9, 1);
  });
});

describe('the recording set', () => {
  it('covers every Overpass answer the repository reads', () => {
    const shapes = [...new Set(loadRawIndex().map((entry) => entry.shape))].sort();
    expect(shapes).toEqual([...RAW_SHAPES].sort());
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

  /** An index that has drifted from the files it lists is worse than no index. */
  it('describes the files it lists', () => {
    for (const entry of loadRawIndex()) {
      const recording = loadRawFixture(entry.shape, entry.subject);
      expect(recording.timestampOsmBase, entry.file).toBe(entry.timestampOsmBase);
      expect(recording.response.elements ?? [], entry.file).toHaveLength(entry.elements);
    }
  });
});
