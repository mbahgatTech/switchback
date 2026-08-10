/**
 * The comparison harness, over the two cached tiles and the synthetic cases. Half of this file is
 * the harness proving it can fail — every mutant is a plausible index bug, and each must be caught.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baselineCandidate,
  compareCandidate,
  diffAssociation,
  formatReport,
  type Candidate,
  type ComparisonReport,
  type TrailInput,
} from './support/association';
import { gridCandidate } from './support/association-candidates';
import {
  boundaryBlindGrid,
  narrowBuffer,
  parkingRadiusForgotten,
  reversedOrder,
  terminusBlind,
  unpaddedGrid,
} from './support/association-mutants';
import {
  POSTGIS_RADIUS_MARGIN_M,
  openPostgis,
  type PostgisSession,
} from './support/association-postgis';
import { edgeCases, type EdgeCase } from './support/enrich-edge-cases';
import { loadEnrichFixture } from './support/enrich-fixture';
import { attachWaypoints, terminusFeatures, type EnrichedWaypoint } from '../src/enrich';
import { FEATURE_CELL_M } from '../src/feature-index';

const SPARSE = '021231030';
const DENSE = '023010230';

const sparse = loadEnrichFixture(SPARSE);
const dense = loadEnrichFixture(DENSE);

function trailsOf(fixture: typeof sparse, stride = 1, offset = 0): TrailInput[] {
  return fixture.trails
    .filter((_, index) => index % stride === offset)
    .map((trail) => ({ key: `${trail.osmType}/${trail.osmId}`, coords: trail.coords }));
}

/**
 * The dense tile measures 351.00 ms per trail over all 1,518 (532.8 s a pass) and a comparison
 * runs two passes, so the whole tile is a twenty-minute job per candidate and belongs to
 * `scripts/enrich-bench.ts` — the PR body carries those runs. This stride takes ten trails, which
 * still cross all 30,838 features and carry 60 attachments and 18 terminus kinds between them.
 * Offset off zero deliberately: `assembleTrails` puts the tile's longest relation there.
 */
const DENSE_STRIDE = 150;
const DENSE_OFFSET = 75;
/** What that sample attaches today. A stride that stops exercising the tile fails rather than passes. */
const DENSE_SAMPLE_WAYPOINTS = 60;

function expectHarnessRan(report: ComparisonReport, waypointsAtLeast: number): void {
  expect(report.trailsCompared).toBe(report.trailsExpected);
  expect(report.trailsCompared).toBeGreaterThan(0);
  expect(report.waypointsExpected).toBeGreaterThanOrEqual(waypointsAtLeast);
}

describe('cached tile fixtures', () => {
  // Exact, not approximate: the fixtures are committed and a benchmark run must be reproducible.
  // Re-fetching from Overpass moves these numbers, and updating them is a deliberate act.
  it('are the two densities the brief names', () => {
    expect(sparse.features).toHaveLength(556);
    expect(sparse.trails).toHaveLength(144);
    expect(dense.features).toHaveLength(30_838);
    expect(dense.trails).toHaveLength(1_518);
    expect(dense.features.length / sparse.features.length).toBeGreaterThan(50);
  });

  it('carry trails whose association is not empty', () => {
    const attached = trailsOf(sparse).flatMap((trail) =>
      attachWaypoints(trail.coords, sparse.features),
    );
    expect(attached.length).toBeGreaterThan(100);
    const withTermini = trailsOf(sparse).filter((trail) => {
      const termini = terminusFeatures(trail.coords, sparse.features);
      return termini.start.length > 0 || termini.end.length > 0;
    });
    expect(withTermini.length).toBeGreaterThan(0);
    // Two unindexed passes over the whole sparse tile: 3.6 s on an idle machine, and vitest's
    // 5 s default leaves no room for a loaded one.
  }, 120_000);
});

describe('the baseline compares identical to itself', () => {
  it(`over every trail in ${SPARSE} (556 features)`, async () => {
    const report = await compareCandidate(sparse.features, trailsOf(sparse), baselineCandidate);
    expectHarnessRan(report, 100);
    expect(formatReport(report)).toContain('identical=true');
    expect(report.waypointsSeen).toBe(report.waypointsExpected);
  }, 120_000);

  it(`over a sample of ${DENSE} (30,838 features)`, async () => {
    const report = await compareCandidate(
      dense.features,
      trailsOf(dense, DENSE_STRIDE, DENSE_OFFSET),
      baselineCandidate,
    );
    expectHarnessRan(report, DENSE_SAMPLE_WAYPOINTS);
    expect(report.identical).toBe(true);
  }, 120_000);
});

describe('edge cases', () => {
  const cases = edgeCases();

  it('cover every shape the brief names', () => {
    expect(cases.map((edge) => edge.name)).toEqual([
      'buffer-epsilon',
      'cell-boundary-150m',
      'cell-boundary-250m',
      'cell-boundary-500m',
      'trail-across-many-cells',
      'features-outside-trail-bounds',
      'antimeridian',
      'polar',
      'empty-feature-set',
      'single-feature-set',
      'duplicate-features',
      'degenerate-trails',
    ]);
  });

  for (const edge of cases) {
    describe(edge.name, () => {
      const attached = new Set(
        edge.trails.flatMap((trail) =>
          attachWaypoints(trail.coords, edge.features).map(
            (waypoint) => `${waypoint.osmType}/${waypoint.osmId}`,
          ),
        ),
      );

      // Without this the case could stop exercising anything and still compare equal, which is
      // the defect this repository keeps producing: a check that cannot tell success from failure.
      it(`is live — ${edge.why}`, () => {
        expect([...attached].sort()).toEqual([...edge.mustAttach].sort());
        for (const key of edge.mustNotAttach) expect(attached.has(key)).toBe(false);
      });

      it('compares identical against the baseline', async () => {
        const report = await compareCandidate(edge.features, edge.trails, baselineCandidate);
        expect(report.trailsCompared).toBe(edge.trails.length);
        expect(report.identical).toBe(true);
      });
    });
  }
});

describe('the comparison detects divergence', () => {
  const cases = edgeCases();
  const caseNamed = (name: string): EdgeCase => cases.find((edge) => edge.name === name)!;

  async function runOn(edge: EdgeCase, candidate: Candidate): Promise<ComparisonReport> {
    return compareCandidate(edge.features, edge.trails, candidate);
  }

  it('catches a grid that never looks in the neighbouring cell', async () => {
    for (const name of ['cell-boundary-150m', 'cell-boundary-250m', 'cell-boundary-500m']) {
      const report = await runOn(caseNamed(name), boundaryBlindGrid);
      expect(report.identical, `${name}: ${formatReport(report)}`).toBe(false);
      expect(report.divergences.some((one) => one.kind === 'waypoint-missing')).toBe(true);
      // Only ever loses features. An extra or a reordering would mean the mutant is wrong in a
      // second way and the assertion above proves nothing about boundaries.
      expect(new Set(report.divergences.map((one) => one.kind))).toEqual(
        new Set(['waypoint-missing']),
      );
      expect(report.waypointsSeen).toBeLessThan(report.waypointsExpected);
    }
  });

  it('catches the same grid on a real tile', async () => {
    const report = await compareCandidate(sparse.features, trailsOf(sparse), boundaryBlindGrid);
    expectHarnessRan(report, 100);
    expect(report.identical).toBe(false);
    expect(report.divergentTrails).toBeGreaterThan(0);
    expect(report.divergences[0]!.trail).toMatch(/^(relation|way)\/\d+$/);
    expect(report.divergences[0]!.subject).toMatch(/^(node|way)\/\d+$/);
  }, 120_000);

  it('catches a buffer one millimetre short of 150 m', async () => {
    const report = await runOn(caseNamed('buffer-epsilon'), narrowBuffer);
    expect(report.identical, formatReport(report)).toBe(false);
    expect(report.divergences.map((one) => one.kind)).toEqual(['waypoint-missing']);
  });

  it('catches the same features visited in a different order', async () => {
    const report = await runOn(caseNamed('duplicate-features'), reversedOrder);
    expect(report.identical, formatReport(report)).toBe(false);
    expect(new Set(report.divergences.map((one) => one.kind))).toEqual(
      new Set(['waypoint-missing', 'waypoint-extra']),
    );
  });

  it('catches termini that were never computed', async () => {
    const report = await runOn(caseNamed('antimeridian'), terminusBlind);
    expect(report.identical, formatReport(report)).toBe(false);
    expect(report.divergences.every((one) => one.kind === 'terminus')).toBe(true);
  });

  it("catches parking indexed at the waypoint radius instead of parking's", async () => {
    const report = await runOn(caseNamed('features-outside-trail-bounds'), parkingRadiusForgotten);
    expect(report.identical, formatReport(report)).toBe(false);
    expect(report.divergences.map((one) => one.detail).join(' ')).toContain('Car park');
  });

  /**
   * The shipped grid's own failure mode, against the boundary built for its own cell size. If
   * this ever passes, `sweep`'s padding has stopped being load-bearing or the case has stopped
   * straddling a cell line — either way the parity suite below has gone blind.
   */
  it('catches the shipped grid with its buffer padding removed', async () => {
    const report = await runOn(caseNamed(`cell-boundary-${FEATURE_CELL_M}m`), unpaddedGrid);
    expect(report.identical, formatReport(report)).toBe(false);
    expect(report.divergences.some((one) => one.kind === 'waypoint-missing')).toBe(true);
    expect(report.waypointsSeen).toBeLessThan(report.waypointsExpected);
  });
});

describe('divergence classification', () => {
  const waypoint = (over: Partial<EnrichedWaypoint> = {}): EnrichedWaypoint => ({
    kind: 'summit',
    name: 'A',
    lng: 1,
    lat: 2,
    distM: 10,
    offsetM: 5,
    osmEleM: null,
    osmType: 'node',
    osmId: 1,
    tags: { natural: 'peak' },
    ...over,
  });
  const empty = { start: [], end: [] };

  it('names a field that drifted', () => {
    const [divergence] = diffAssociation(
      't',
      { waypoints: [waypoint()], termini: empty },
      { waypoints: [waypoint({ distM: 10.000001 })], termini: empty },
    );
    expect(divergence).toMatchObject({ kind: 'waypoint-field', subject: 'node/1.distM' });
  });

  it('names a reordering without also reporting every field', () => {
    const a = waypoint({ osmId: 1 });
    const b = waypoint({ osmId: 2, name: 'B' });
    const found = diffAssociation(
      't',
      { waypoints: [a, b], termini: empty },
      { waypoints: [b, a], termini: empty },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'waypoint-order', subject: 'index 0' });
  });

  it('names a feature attached twice', () => {
    const one = waypoint();
    const found = diffAssociation(
      't',
      { waypoints: [one], termini: empty },
      { waypoints: [one, one], termini: empty },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'waypoint-duplicated', subject: 'node/1' });
  });

  it('distinguishes terminus order from terminus membership', () => {
    const reordered = diffAssociation(
      't',
      { waypoints: [], termini: { start: ['summit', 'parking'], end: [] } },
      { waypoints: [], termini: { start: ['parking', 'summit'], end: [] } },
    );
    expect(reordered).toHaveLength(1);
    expect(reordered[0]).toMatchObject({ kind: 'terminus', subject: 'start' });
  });
});

/**
 * The two candidates, each held to the same bar: byte-identical to the current implementation
 * over both cached tiles and every synthetic case. `make` takes the trails because a bulk join
 * answers the whole tile in one query and has to know what to ask about.
 */
function describeParity(title: string, make: (trails: readonly TrailInput[]) => Candidate): void {
  describe(title, () => {
    it(`is identical over every trail in ${SPARSE} (556 features)`, async () => {
      const trails = trailsOf(sparse);
      const report = await compareCandidate(sparse.features, trails, make(trails));
      expectHarnessRan(report, 100);
      expect(report.identical, formatReport(report)).toBe(true);
      expect(report.waypointsSeen).toBe(report.waypointsExpected);
    }, 180_000);

    it(`is identical over a sample of ${DENSE} (30,838 features)`, async () => {
      const trails = trailsOf(dense, DENSE_STRIDE, DENSE_OFFSET);
      const report = await compareCandidate(dense.features, trails, make(trails));
      expectHarnessRan(report, DENSE_SAMPLE_WAYPOINTS);
      expect(report.identical, formatReport(report)).toBe(true);
      expect(report.waypointsSeen).toBe(report.waypointsExpected);
    }, 180_000);

    for (const edge of edgeCases()) {
      it(`is identical on ${edge.name} — ${edge.why}`, async () => {
        const report = await compareCandidate(edge.features, edge.trails, make(edge.trails));
        expect(report.trailsCompared).toBe(edge.trails.length);
        expect(report.identical, formatReport(report)).toBe(true);
      }, 60_000);
    }
  });
}

describeParity('candidate A — in-memory uniform grid', () => gridCandidate());

/**
 * Candidate B needs a live PostGIS, and only a local one: it creates temporary tables, and
 * pointing a benchmark at a hosted database by accident is a class of mistake worth making
 * structurally impossible. CI runs the same postgis image `infra/docker-compose.yml` does.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(DATABASE_URL);
const describePostgis = IS_LOCAL ? describe : describe.skip;

describePostgis('candidate B — PostGIS spatial join', () => {
  let session: PostgisSession;

  beforeAll(async () => {
    session = await openPostgis(DATABASE_URL);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
  });

  describeParity('one ST_DWithin per trail', () => session.perTrail());
  describeParity('one join for the whole tile', (trails) => session.bulk(trails));

  /**
   * The radius PostGIS is asked for carries slack, because `ST_DWithin` measures the distance to
   * the geodesic and `nearestPointOnSegment` measures haversine to a point interpolated in
   * degrees. The slack has to cover the gap; this asserts it does, over real geometry.
   */
  it('keeps the radius margin above the two distance functions’ disagreement', async () => {
    const worst = await session.measureMargin(sparse.features, trailsOf(sparse));
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(POSTGIS_RADIUS_MARGIN_M);
  }, 180_000);
});
