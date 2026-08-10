/**
 * Diffs a candidate feature-to-trail association against the current one, per trail and per
 * feature. The failure mode is silent: attach fewer features and trails just lose waypoints.
 */

import type { LngLat } from '@switchback/core';
import type { TerminusKinds } from '@switchback/geo';
import { attachWaypoints, terminusFeatures, type EnrichedWaypoint } from '../../src/enrich';
import type { OverpassElement } from '../../src/overpass';

/** Everything one trail's enrichment produces from the tile's feature set. */
export interface TrailAssociation {
  waypoints: EnrichedWaypoint[];
  termini: TerminusKinds;
}

export interface Associator {
  associate(coords: readonly LngLat[]): Promise<TrailAssociation> | TrailAssociation;
}

/**
 * `build` runs once per tile, so an index's construction cost is measured apart from the queries
 * it serves. Async throughout so a database-backed candidate needs no second harness.
 */
export interface Candidate {
  readonly name: string;
  build(features: readonly OverpassElement[]): Promise<Associator> | Associator;
}

/**
 * The current implementation, as the thing every candidate is measured against. Both passes read
 * one coordinate list; `commitTrail` orients the waypoint pass and not the terminus pass, which a
 * comparison does not care about — only that baseline and candidate see identical input.
 */
export const baselineCandidate: Candidate = {
  name: 'baseline',
  build: (features) => ({
    associate: (coords) => ({
      waypoints: attachWaypoints(coords, features),
      termini: terminusFeatures(coords, features),
    }),
  }),
};

export interface TrailInput {
  key: string;
  coords: readonly LngLat[];
}

export type DivergenceKind =
  | 'waypoint-missing'
  | 'waypoint-extra'
  | 'waypoint-duplicated'
  | 'waypoint-order'
  | 'waypoint-field'
  | 'terminus';

/** One difference, named down to the trail and the feature that produced it. */
export interface Divergence {
  trail: string;
  kind: DivergenceKind;
  /** `node/123456` for a feature-level difference; `start` or `end` for a terminus one. */
  subject: string;
  detail: string;
}

export interface ComparisonReport {
  candidate: string;
  /** Trails the candidate was actually asked about. Must equal `trailsExpected`. */
  trailsCompared: number;
  trailsExpected: number;
  /** Baseline waypoint attachments summed over every trail — the quantity a bug silently loses. */
  waypointsExpected: number;
  waypointsSeen: number;
  divergentTrails: number;
  divergences: Divergence[];
  /** Divergences past `maxDivergences`, counted but not recorded. */
  omittedDivergences: number;
  identical: boolean;
}

const MAX_DIVERGENCES = 200;

/**
 * Run both implementations over the same trails and diff them. Sequential, so a candidate that
 * hands work to another process shows its real wall-clock cost.
 */
export async function compareCandidate(
  features: readonly OverpassElement[],
  trails: readonly TrailInput[],
  candidate: Candidate,
  options: { maxDivergences?: number } = {},
): Promise<ComparisonReport> {
  const limit = options.maxDivergences ?? MAX_DIVERGENCES;
  const baseline = await baselineCandidate.build(features);
  const subject = await candidate.build(features);

  const divergences: Divergence[] = [];
  let omitted = 0;
  let divergentTrails = 0;
  let trailsCompared = 0;
  let waypointsExpected = 0;
  let waypointsSeen = 0;

  for (const trail of trails) {
    const expected = await baseline.associate(trail.coords);
    const actual = await subject.associate(trail.coords);
    trailsCompared += 1;
    waypointsExpected += expected.waypoints.length;
    waypointsSeen += actual.waypoints.length;

    const found = diffAssociation(trail.key, expected, actual);
    if (found.length > 0) divergentTrails += 1;
    for (const divergence of found) {
      if (divergences.length < limit) divergences.push(divergence);
      else omitted += 1;
    }
  }

  return {
    candidate: candidate.name,
    trailsCompared,
    trailsExpected: trails.length,
    waypointsExpected,
    waypointsSeen,
    divergentTrails,
    divergences,
    omittedDivergences: omitted,
    identical: divergentTrails === 0,
  };
}

export function diffAssociation(
  trail: string,
  expected: TrailAssociation,
  actual: TrailAssociation,
): Divergence[] {
  return [
    ...diffWaypoints(trail, expected.waypoints, actual.waypoints),
    ...diffTermini(trail, expected.termini, actual.termini),
  ];
}

function featureKey(waypoint: EnrichedWaypoint): string {
  return `${waypoint.osmType}/${waypoint.osmId}`;
}

/**
 * Membership, then multiplicity, then order, then fields — separated because a missing feature is
 * data loss, a reordering is a UI change and a field drift is an arithmetic difference.
 */
function diffWaypoints(
  trail: string,
  expected: readonly EnrichedWaypoint[],
  actual: readonly EnrichedWaypoint[],
): Divergence[] {
  const out: Divergence[] = [];
  const expectedCounts = countByKey(expected);
  const actualCounts = countByKey(actual);

  for (const [key, count] of expectedCounts) {
    const seen = actualCounts.get(key) ?? 0;
    if (seen === 0) {
      const waypoint = expected.find((candidate) => featureKey(candidate) === key)!;
      out.push({
        trail,
        kind: 'waypoint-missing',
        subject: key,
        detail:
          `${waypoint.kind} "${waypoint.name ?? '(unnamed)'}" at ` +
          `${waypoint.lng},${waypoint.lat} offset ${waypoint.offsetM} m is attached by the ` +
          `baseline and absent from the candidate`,
      });
    } else if (seen !== count) {
      out.push({
        trail,
        kind: 'waypoint-duplicated',
        subject: key,
        detail: `attached ${count}x by the baseline and ${seen}x by the candidate`,
      });
    }
  }

  for (const [key, count] of actualCounts) {
    if (expectedCounts.has(key)) continue;
    const waypoint = actual.find((candidate) => featureKey(candidate) === key)!;
    out.push({
      trail,
      kind: 'waypoint-extra',
      subject: key,
      detail:
        `${waypoint.kind} "${waypoint.name ?? '(unnamed)'}" at ` +
        `${waypoint.lng},${waypoint.lat} offset ${waypoint.offsetM} m is attached ${count}x by ` +
        `the candidate and not by the baseline`,
    });
  }

  const expectedOrder = expected.map(featureKey);
  const actualOrder = actual.map(featureKey);
  const firstSwap = expectedOrder.findIndex((key, index) => key !== actualOrder[index]);
  if (out.length === 0 && firstSwap !== -1) {
    out.push({
      trail,
      kind: 'waypoint-order',
      subject: `index ${firstSwap}`,
      detail: `baseline has ${expectedOrder[firstSwap]}, candidate has ${actualOrder[firstSwap]}`,
    });
  }

  // Fields are compared only where both sides agree on the ordering, so a single reordering does
  // not report every subsequent waypoint as a field mismatch as well.
  if (out.length === 0) {
    for (const [index, waypoint] of expected.entries()) {
      out.push(...diffFields(trail, waypoint, actual[index]!));
    }
  }
  return out;
}

const COMPARED_FIELDS = [
  'kind',
  'name',
  'lng',
  'lat',
  'distM',
  'offsetM',
  'osmEleM',
  'osmType',
  'osmId',
] as const;

function diffFields(
  trail: string,
  expected: EnrichedWaypoint,
  actual: EnrichedWaypoint,
): Divergence[] {
  const out: Divergence[] = [];
  for (const field of COMPARED_FIELDS) {
    const a = expected[field];
    const b = actual[field];
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
      continue;
    }
    out.push({
      trail,
      kind: 'waypoint-field',
      subject: `${featureKey(expected)}.${field}`,
      detail: `baseline ${JSON.stringify(a)}, candidate ${JSON.stringify(b)}`,
    });
  }
  const expectedTags = JSON.stringify(expected.tags);
  const actualTags = JSON.stringify(actual.tags);
  if (expectedTags !== actualTags) {
    out.push({
      trail,
      kind: 'waypoint-field',
      subject: `${featureKey(expected)}.tags`,
      detail: `baseline ${expectedTags}, candidate ${actualTags}`,
    });
  }
  return out;
}

/** Order and multiplicity both count: `terminusKinds` returns a list, and duplicates are real. */
function diffTermini(trail: string, expected: TerminusKinds, actual: TerminusKinds): Divergence[] {
  const out: Divergence[] = [];
  for (const end of ['start', 'end'] as const) {
    const a = JSON.stringify(expected[end]);
    const b = JSON.stringify(actual[end]);
    if (a === b) continue;
    out.push({
      trail,
      kind: 'terminus',
      subject: end,
      detail: `baseline ${a}, candidate ${b}`,
    });
  }
  return out;
}

function countByKey(waypoints: readonly EnrichedWaypoint[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const waypoint of waypoints) {
    const key = featureKey(waypoint);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The report as a human would want it in a PR body or a test failure. */
export function formatReport(report: ComparisonReport): string {
  const lines = [
    `candidate=${report.candidate} identical=${report.identical}`,
    `completed=${report.trailsCompared}/${report.trailsExpected} trails, ` +
      `waypoints baseline=${report.waypointsExpected} candidate=${report.waypointsSeen}`,
  ];
  if (!report.identical) {
    lines.push(`divergent trails: ${report.divergentTrails}`);
    for (const divergence of report.divergences) {
      lines.push(`  ${divergence.trail} ${divergence.kind} ${divergence.subject}`);
      lines.push(`    ${divergence.detail}`);
    }
    if (report.omittedDivergences > 0) {
      lines.push(`  ...and ${report.omittedDivergences} more`);
    }
  }
  return lines.join('\n');
}
