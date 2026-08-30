/**
 * `assembleTrails` held to what it makes of recorded Overpass answers, so a change of trail
 * source is a diff rather than a surprise.
 */

import { describe, expect, it } from 'vitest';
import { assembleTrails } from '../src/assemble';
import type { OverpassQuerier, OverpassRelation } from '../src/overpass';
import { fetchRelationInParts } from '../src/pipeline';
import {
  DENSE_TILE,
  SPARSE_TILE,
  assembleAsRecorded,
  loadAssembleGolden,
  loadRawFixture,
  memberWaySequences,
  summariseRecording,
  summariseTrails,
} from './support/raw-fixture';

/** Trail A: 9,081.9 m over three chained ways, of seven the relation declares. */
const TRAIL_A = 7470475;

/** A recorded tile, what assembly makes of it now, and what it is held to. */
function tileCase(density: string, quadkey: string, count: number) {
  const recording = loadRawFixture('tile', quadkey);
  return {
    density,
    count,
    elements: recording.response.elements ?? [],
    trails: summariseRecording(recording),
    golden: loadAssembleGolden('tile', quadkey),
  };
}

const sparse = tileCase('sparse', SPARSE_TILE, 145);
const dense = tileCase('dense', DENSE_TILE, 1_517);

describe.each([sparse, dense])('the $density tile', ({ trails, golden, count }) => {
  /**
   * Every field of every trail, `lengthM` and `bridgedM` among them: moving one member way 60 m
   * breaks the chain at a shared node and `pickPrimary` keeps the longer half, so the trail
   * survives under its own name at a fraction of its length.
   */
  it('assembles to the committed golden', () => {
    // The count first: an empty recording and an empty golden compare equal.
    expect(trails).toHaveLength(count);
    expect(trails).toEqual(golden.trails);
  });
});

describe('the order elements arrive in', () => {
  const identity = (trail: { osmType: string; osmId: number }) => `${trail.osmType}/${trail.osmId}`;
  const ascending = (ids: readonly number[]) => ids.every((id, i) => i === 0 || ids[i - 1]! <= id);

  /** Top-level ways backwards: osm2pgsql's geometry-cluster order, in the shape it was caught in. */
  const reversed = [...sparse.elements].reverse();

  /** Every relation's members by way id — what a member join without `WITH ORDINALITY` returns. */
  const membersSorted = structuredClone(sparse.elements);
  for (const element of membersSorted) {
    if (element.type === 'relation') element.members?.sort((a, b) => a.ref - b.ref);
  }

  /**
   * Why a trail count is no evidence of parity. `chainWays` seeds greedily in iteration order, so
   * listing the same ways backwards assembles the golden's 145 trails with one of them under a
   * different identity built from different member ways.
   */
  it('decides which trails exist, not merely how many', () => {
    const scrambled = summariseTrails(assembleTrails(reversed));
    const gained = scrambled
      .map(identity)
      .filter((id) => !sparse.golden.trails.some((t) => identity(t) === id));
    const lost = sparse.golden.trails
      .map(identity)
      .filter((id) => !scrambled.some((t) => identity(t) === id));

    expect(scrambled).toHaveLength(sparse.count);
    expect(gained).toEqual(['way/722501778']);
    expect(lost).toEqual(['way/722483990']);
  });

  /**
   * The same argument one level down, and sharper: `chainWays` seeds on a relation's member list
   * too. Sorting those leaves the sparse tile's trail count, every identity, and the changed
   * trail's vertex count and length — equal to the nanometre, differing only in the order the
   * segments are summed — and reverses the line it draws. A reader scanning counts and lengths
   * passes over it.
   */
  it('decides how a relation is traversed, not merely which trails exist', () => {
    const scrambled = summariseTrails(assembleTrails(membersSorted));
    const differing = scrambled.filter(
      (trail, index) => JSON.stringify(trail) !== JSON.stringify(sparse.golden.trails[index]),
    );
    const [changed] = differing;
    const before = sparse.golden.trails.find((t) => identity(t) === identity(changed!))!;

    expect(scrambled.map(identity)).toEqual(sparse.golden.trails.map(identity));
    expect(differing).toHaveLength(1);
    expect(changed!.lengthM).toBeCloseTo(before.lengthM, 9);
    expect(changed!.coords.vertices).toBe(before.coords.vertices);
    expect(changed!.memberWayIds).toEqual([...before.memberWayIds].reverse());
    expect(changed!.coords.sha256).not.toBe(before.coords.sha256);
  });

  /** Sorting the input instead would let a source pass parity in an order production never gives it. */
  it('is a precondition of the seam, refused rather than absorbed', () => {
    // Positive control: the recording is the order the contract is stated against, so it passes.
    expect(assembleAsRecorded(sparse.elements, sparse.elements)).toEqual(sparse.golden.trails);

    expect(() => assembleAsRecorded(reversed, sparse.elements)).toThrow(
      /ordered by way id ascending/u,
    );
    expect(() => assembleAsRecorded(membersSorted, sparse.elements)).toThrow(/WITH ORDINALITY/u);
  });

  /**
   * The two halves of the contract are different rules, which is why one guard cannot serve both:
   * Overpass sorts top-level ways by id, while a relation declares its ways in route order, which
   * sorting silently rewrites rather than normalises.
   */
  it('is ascending at the top level and route order inside a relation', () => {
    const topLevelWayIds = dense.elements.filter((e) => e.type === 'way').map((e) => e.id);
    const declared = [...memberWaySequences(dense.elements).values()].filter(
      (ids) => ids.length > 1,
    );

    expect(ascending(topLevelWayIds)).toBe(true);
    expect(declared.filter((ids) => !ascending(ids)).length).toBeGreaterThan(0);
  });
});

describe('the default gap tolerance', () => {
  /**
   * `assemble.test.ts` covers `bridgeGaps` directly, but with hand-made two-vertex lines and the
   * tolerance passed as a literal, so nothing in it feels the default. Two trails in the sparse
   * tile are joined across real gaps inside the 40 m default and far outside the 1 cm that counts
   * as a shared node: dropping the default to 4 m leaves all eighteen synthetic cases green and
   * turns this red.
   */
  it('bridges two gaps in the sparse tile', () => {
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
   * would have returned. Both answers are recorded, so the claim is checked through assembly,
   * which is what the claim is *for* — and through the seam, so a splice that reordered the
   * members it stitched back together is refused rather than compared.
   */
  it('assembles identically to the same relation fetched whole', async () => {
    const rebuilt = await fetchRelationInParts(
      TRAIL_A,
      { overpass },
      () => {},
      0,
      new Error('mirror refused the relation whole'),
    );
    const recording = loadRawFixture('route', String(TRAIL_A));
    const whole = recording.response.elements ?? [];

    expect(assembleAsRecorded([rebuilt], whole)).toEqual(summariseRecording(recording));
    expect(summariseRecording(recording)).toEqual(
      loadAssembleGolden('route', String(TRAIL_A)).trails,
    );
    // The one length this file's prose and the fixture README both quote, so neither goes stale
    // quietly behind a golden nobody reads line by line.
    expect(summariseRecording(recording)[0]!.lengthM).toBeCloseTo(9_081.9, 1);
  });
});

describe('a member way with a hole in it', () => {
  /**
   * A missing position is a truncated response, not a clipped way, and interpolating across it
   * would invent geometry. Trail A is three chained ways; holing the last drops it and leaves the
   * two that still chain, so the trail shortens rather than keeping its length across a span
   * nobody surveyed.
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
