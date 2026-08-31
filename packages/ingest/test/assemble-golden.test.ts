/**
 * `assembleTrails` held to what it makes of recorded Overpass answers, so a change of trail
 * source is a diff rather than a surprise.
 */

import { describe, expect, it } from 'vitest';
import { assembleTrails } from '../src/assemble';
import type {
  OverpassElement,
  OverpassQuerier,
  OverpassRelation,
  OverpassWay,
} from '../src/overpass';
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
    recording,
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

  /** Top-level ways backwards: the coarsest way out of id order, and the shape it was caught in. */
  const reversed = [...sparse.elements].reverse();

  /** Every relation's members by way id — what a member join without `WITH ORDINALITY` returns. */
  const membersSorted = structuredClone(sparse.elements);
  for (const element of membersSorted) {
    if (element.type === 'relation') element.members?.sort((a, b) => a.ref - b.ref);
  }

  /**
   * Each relation's member ways sorted between its first and its last, both of which stay where the
   * recording put them — what a rebuild that walks the members outward from a declared endpoint
   * returns, and the shape an endpoint comparison cannot see.
   */
  function interiorReordered(elements: readonly OverpassElement[]): OverpassElement[] {
    const clone = structuredClone(elements) as OverpassElement[];
    for (const element of clone) {
      if (element.type !== 'relation') continue;
      const ways = element.members.filter((member) => member.type === 'way');
      if (ways.length < 4) continue;
      const held = [ways[0]!, ...ways.slice(1, -1).sort((a, b) => a.ref - b.ref), ways.at(-1)!];
      let next = 0;
      element.members = element.members.map((member) =>
        member.type === 'way' ? held[next++]! : member,
      );
    }
    return clone;
  }

  /**
   * Top-level ways in geometry order between the first and the last, both of which stay where the
   * recording put them — what a tile query against osm2pgsql returns, which clusters ways by
   * geohash rather than by id, and the shape a comparison of the two ends cannot see.
   */
  function clusteredBetweenEnds(elements: readonly OverpassElement[]): OverpassElement[] {
    const clone = structuredClone(elements) as OverpassElement[];
    const ways = clone.filter((element): element is OverpassWay => element.type === 'way');
    const cell = (way: OverpassWay): [number, number] => {
      const [first] = way.geometry ?? [];
      return [Math.round((first?.lat ?? 0) * 100), Math.round((first?.lon ?? 0) * 100)];
    };
    const interior = ways.slice(1, -1).sort((a, b) => {
      const [aLat, aLon] = cell(a);
      const [bLat, bLon] = cell(b);
      return aLat - bLat || aLon - bLon || a.id - b.id;
    });
    const held = [ways[0]!, ...interior, ways.at(-1)!];
    let next = 0;
    return clone.map((element) => (element.type === 'way' ? held[next++]! : element));
  }

  /** Built once: three cases below read it, and the dense tile is 4,990 elements. */
  const clustered = clusteredBetweenEnds(dense.elements);

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
   * The top level at the positions an endpoint comparison cannot reach: the smallest way id is
   * still first and the largest still last, so a guard reduced to either end — or to a scan that
   * never carries past the first id — accepts this. Assembled, the dense tile keeps the golden's
   * 1,517 trails exactly while twelve identities are swapped for twelve others and seventy-one
   * more draw a different line under an identity the golden also carries.
   */
  it('holds top-level ways at every position, not at their ends', () => {
    const served = clustered.filter((element) => element.type === 'way').map(({ id }) => id);
    const recorded = dense.elements.filter((element) => element.type === 'way').map(({ id }) => id);
    const byId = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

    // A reordering and nothing else, both ends left alone and the smallest id still first:
    // otherwise the divergence below would be evidence of ways lost rather than of the order they
    // arrive in, and the reductions this exists to catch would be refused for the wrong reason.
    expect(byId(served)).toEqual(byId(recorded));
    expect([served[0], served.at(-1)]).toEqual([recorded[0], recorded.at(-1)]);
    expect(served[0]).toBe(Math.min(...served));
    expect(ascending(served)).toBe(false);

    expect(() => assembleAsRecorded(clustered, dense.elements)).toThrow(
      /ordered by way id ascending/u,
    );

    const golden = new Map(dense.golden.trails.map((trail) => [identity(trail), trail]));
    const accepted = summariseTrails(assembleTrails(clustered));

    expect({
      trails: accepted.length,
      gained: accepted.filter((trail) => !golden.has(identity(trail))).length,
      geometryMoved: accepted.filter((trail) => {
        const before = golden.get(identity(trail));
        return before !== undefined && before.coords.sha256 !== trail.coords.sha256;
      }).length,
    }).toEqual({ trails: dense.count, gained: 12, geometryMoved: 71 });
  });

  /**
   * Which way arrived out of order, and which one it arrived after. Named the wrong way round the
   * refusal states the relation the contract *wants* — the smaller id printed as following the
   * larger — so it reads as an instruction to move the way that was already in place; named from
   * constants it leaves a reader of a 4,932-way tile nothing to look up. Both ids are read off the
   * candidate's own served sequence here, so the guard cannot agree with itself.
   */
  it('names the way that arrived out of order and the one it arrived after', () => {
    const served = clustered.filter((element) => element.type === 'way').map(({ id }) => id);
    const at = served.findIndex((id, index) => index > 0 && id < served[index - 1]!);

    // The first descent, which is where a scan carrying its cursor forward stops, and a real one:
    // named from an ascending pair the refusal could be printed either way round and still agree.
    expect(at).toBeGreaterThan(0);
    expect(served[at]!).toBeLessThan(served[at - 1]!);

    expect(() => assembleAsRecorded(clustered, dense.elements)).toThrow(
      `way ${served[at]} arrives after way ${served[at - 1]}`,
    );
  });

  /**
   * The same precondition on the path a golden is *written* from: `scripts/enrich-fixture.ts`
   * derives one through `summariseRecording`. Re-recorded from a mirror that clusters ways by
   * geometry, the tile would otherwise be written straight into `golden/` — at the trail count the
   * recorder prints and an operator checks, with different trails under it.
   */
  it('refuses that order in a recording a golden would be derived from', () => {
    const rerecorded = {
      ...dense.recording,
      response: { ...dense.recording.response, elements: clustered },
    };

    expect(() => summariseRecording(rerecorded)).toThrow(/ordered by way id ascending/u);

    // Why refusing beats diffing: the one figure the re-record prints does not move.
    const wouldWrite = summariseTrails(assembleTrails(clustered));

    expect(wouldWrite).toHaveLength(dense.golden.trails.length);
    expect(wouldWrite.map(identity)).not.toEqual(dense.golden.trails.map(identity));
  });

  /**
   * The interior of a member list, which is where an endpoint comparison sees nothing: every
   * relation here keeps the first and last way the recording gave it. Refusing that is not
   * pedantry — assembled, the dense tile comes back 1,513 trails against the golden's 1,517,
   * six of the golden's gone.
   */
  it('holds a member list at every position, not at its ends', () => {
    const candidate = interiorReordered(dense.elements);
    const recorded = memberWaySequences(dense.elements);
    const rows = [...memberWaySequences(candidate)].map(([id, seq]) => ({
      id,
      seq,
      was: recorded.get(id)!,
    }));
    const asMultiset = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join();
    const ends = (ids: readonly number[]) => `${ids[0]}..${ids.at(-1)}`;

    // A reordering and nothing else, both ends left alone: otherwise the divergence below would be
    // evidence of ways lost, not of the order they arrive in.
    expect(rows.filter((r) => asMultiset(r.seq) !== asMultiset(r.was)).map((r) => r.id)).toEqual(
      [],
    );
    expect(rows.filter((r) => ends(r.seq) !== ends(r.was)).map((r) => r.id)).toEqual([]);
    expect(rows.filter((r) => r.seq.join() !== r.was.join()).length).toBeGreaterThan(0);

    expect(() => assembleAsRecorded(candidate, dense.elements)).toThrow(/WITH ORDINALITY/u);

    const accepted = new Set(summariseTrails(assembleTrails(candidate)).map(identity));
    const lost = dense.golden.trails.map(identity).filter((id) => !accepted.has(id));

    expect(accepted.size).toBe(1_513);
    expect(lost).toHaveLength(6);
  });

  /** A prefix is not a match: compared ref by ref alone, a truncated member list passes. */
  it('holds how many members a relation declares', () => {
    const candidate = structuredClone(sparse.elements);
    const truncated = candidate.find(
      (element): element is OverpassRelation => element.type === 'relation',
    )!;
    truncated.members.pop();

    expect(() => assembleAsRecorded(candidate, sparse.elements)).toThrow(/WITH ORDINALITY/u);
  });

  /**
   * Which sequence is the candidate's and which the recording's, and what each one holds. Named
   * the wrong way round the refusal reads as an instruction to sort the side that was already
   * right; printed from a list nothing derived independently it can name any two sequences at all
   * and still agree with itself. Both are read off the relation's own members here.
   */
  it('names the served sequence and the recorded one the right way round', () => {
    const candidate = structuredClone(sparse.elements);
    const relation = candidate.find(
      (element): element is OverpassRelation => element.type === 'relation',
    )!;
    const declared = relation.members
      .filter((member) => member.type === 'way')
      .map((member) => member.ref);
    // Reversing the member list reverses its way members with it, whatever else it holds.
    relation.members.reverse();

    expect(() => assembleAsRecorded(candidate, sparse.elements)).toThrow(
      `serves member ways [${[...declared].reverse().join(', ')}] where the recording declares ` +
        `[${declared.join(', ')}]`,
    );
  });

  /**
   * A relation's members that are not ways: `assembleTrails` skips them, so a source that
   * materialises the member ways alone serves the sequence the recording declares and assembles
   * to the golden. Compared without that distinction the seam refuses a correct source, naming
   * the dense tile's two node members and one member relation as member ways.
   */
  it("compares a relation's way members and not the rest of its members", () => {
    const candidate = structuredClone(dense.elements);
    let dropped = 0;
    for (const element of candidate) {
      if (element.type !== 'relation') continue;
      const ways = element.members.filter((member) => member.type === 'way');
      dropped += element.members.length - ways.length;
      element.members = ways;
    }

    expect(dropped).toBeGreaterThan(0);
    expect(assembleAsRecorded(candidate, dense.elements)).toEqual(dense.golden.trails);
  });

  /**
   * What each fault actually costs, which is the table `fixtures/raw/README.md` states and what a
   * reader uses to judge whether a diff is an ordering problem at all. The lines drawn move in
   * every combination; the trail count survives two and the identity set one, so neither settles
   * the question in either direction.
   */
  it('costs the geometry every time and the trail count only sometimes', () => {
    const membersByRef = (elements: readonly OverpassElement[]) => {
      const clone = structuredClone(elements) as OverpassElement[];
      for (const element of clone) {
        if (element.type === 'relation') element.members.sort((a, b) => a.ref - b.ref);
      }
      return clone;
    };
    const cost = (tile: typeof sparse, candidate: readonly OverpassElement[]) => {
      const golden = new Map(tile.golden.trails.map((trail) => [identity(trail), trail]));
      const after = summariseTrails(assembleTrails(candidate));
      const ids = new Set(after.map(identity));
      return {
        trails: after.length,
        identitiesHeld: ids.size === golden.size && [...ids].every((id) => golden.has(id)),
        // Only trails the golden also carries: a gained identity is a count difference, already
        // reported above, and counting it here would let that stand in for a line that moved.
        geometryMoved: after.some((trail) => {
          const before = golden.get(identity(trail));
          return before !== undefined && before.coords.sha256 !== trail.coords.sha256;
        }),
      };
    };

    expect([
      cost(sparse, reversed),
      cost(dense, [...dense.elements].reverse()),
      cost(sparse, membersSorted),
      cost(dense, membersByRef(dense.elements)),
    ]).toEqual([
      { trails: 145, identitiesHeld: false, geometryMoved: true },
      { trails: 1_521, identitiesHeld: false, geometryMoved: true },
      { trails: 145, identitiesHeld: true, geometryMoved: true },
      { trails: 1_513, identitiesHeld: false, geometryMoved: true },
    ]);
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
