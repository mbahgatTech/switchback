/**
 * The recorded Overpass answers, and the summary a trail source is held to. Gzipped: a dense
 * tile's answer is tens of megabytes of JSON.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { LngLat } from '@switchback/core';
import { assembleTrails, type AssembledTrail } from '../../src/assemble';
import type { OverpassElement, OverpassResponse } from '../../src/overpass';

export const RAW_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'raw',
);

/**
 * The recorded answer shapes, as a type. Not the authority on what this repository asks Overpass
 * for — `overpassShapesInSource()` reads that off the query builders, and a test holds this list
 * to it.
 */
export const RAW_SHAPES = [
  'tile',
  'route',
  'relation-skeleton',
  'way-geometry',
  'parent-route',
  'region',
  'feature',
  'network',
  'tags-by-id',
] as const;

export type RawShape = (typeof RAW_SHAPES)[number];

/** The two z9 tiles recorded end to end — tile, feature answer, and an assembly golden. */
export const SPARSE_TILE = '021231030';
export const DENSE_TILE = '023010230';

export interface RawRecording {
  shape: RawShape;
  /** Quadkey, id, or joined id list — whatever the query was about, and half the file name. */
  subject: string;
  /** The QL as sent, so the recording can be reproduced without the recorder. */
  query: string;
  recordedAt: string;
  /**
   * `osm3s.timestamp_osm_base`: the instant of the planet the answer describes, which is the
   * only thing that dates the *data*. `recordedAt` dates the request, and the two differ by
   * however far behind the mirror was.
   */
  timestampOsmBase: string | null;
  response: OverpassResponse;
}

/** One row per recording, uncompressed so the fixture set is auditable without gunzipping. */
export interface RawIndexEntry {
  shape: RawShape;
  subject: string;
  file: string;
  recordedAt: string;
  timestampOsmBase: string | null;
  elements: number;
  gzippedBytes: number;
}

export function rawFixtureFile(shape: RawShape, subject: string): string {
  return `${shape}.${subject}.json.gz`;
}

export function loadRawFixture(shape: RawShape, subject: string): RawRecording {
  const packed = readFileSync(join(RAW_FIXTURE_DIR, rawFixtureFile(shape, subject)));
  return JSON.parse(gunzipSync(packed).toString('utf8')) as RawRecording;
}

export function loadRawIndex(): RawIndexEntry[] {
  return JSON.parse(readFileSync(join(RAW_FIXTURE_DIR, 'index.json'), 'utf8')) as RawIndexEntry[];
}

/** The recordings the directory actually holds, whatever the index claims about them. */
export function recordedFiles(): string[] {
  return readdirSync(RAW_FIXTURE_DIR)
    .filter((file) => file.endsWith('.json.gz'))
    .sort();
}

/**
 * The index as rebuilt from the recordings on disk. `index.json` is committed as exactly this,
 * so a recording added, re-recorded or deleted without rebuilding leaves a difference rather
 * than a stale row that agrees with itself.
 */
export function buildRawIndex(): RawIndexEntry[] {
  return recordedFiles()
    .map((file): RawIndexEntry => {
      const path = join(RAW_FIXTURE_DIR, file);
      const recording = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as RawRecording;
      return {
        shape: recording.shape,
        subject: recording.subject,
        file,
        recordedAt: recording.recordedAt,
        timestampOsmBase: recording.timestampOsmBase,
        elements: recording.response.elements?.length ?? 0,
        gzippedBytes: statSync(path).size,
      };
    })
    .sort((a, b) => a.shape.localeCompare(b.shape) || a.subject.localeCompare(b.subject));
}

/** A trail's geometry reduced to something a diff can show. */
export interface CoordDigest {
  vertices: number;
  /** SHA-256 over `lng,lat` at 7 dp — OSM's storage precision, and the quantum `keyOf` uses. */
  sha256: string;
}

/**
 * An `AssembledTrail` with its coordinates digested. Every other field is carried through by
 * rest-spread, so a field added to `AssembledTrail` reaches the golden and shows up as a diff
 * rather than being silently dropped.
 */
export type AssembledTrailSummary = Omit<AssembledTrail, 'coords'> & { coords: CoordDigest };

export interface AssembleGolden {
  /** The recording this was derived from. */
  shape: RawShape;
  subject: string;
  /** Copied from that recording, so a golden and a re-recording cannot drift apart unnoticed. */
  timestampOsmBase: string | null;
  trails: AssembledTrailSummary[];
}

export function digestCoords(coords: readonly LngLat[]): CoordDigest {
  const hash = createHash('sha256');
  for (const [lng, lat] of coords) hash.update(`${lng.toFixed(7)},${lat.toFixed(7)};`);
  return { vertices: coords.length, sha256: hash.digest('hex') };
}

/**
 * Assembled trails in the comparable form, sorted by identity so that a reordering of otherwise
 * identical trails is not a divergence. Direction is deliberately *not* normalised: a reversed
 * line is a real difference.
 */
export function summariseTrails(trails: readonly AssembledTrail[]): AssembledTrailSummary[] {
  return trails
    .map(({ coords, ...rest }) => ({ ...rest, coords: digestCoords(coords) }))
    .sort(
      (a, b) =>
        a.osmType.localeCompare(b.osmType) ||
        a.osmId - b.osmId ||
        a.name.localeCompare(b.name) ||
        a.coords.sha256.localeCompare(b.coords.sha256),
    );
}

/**
 * The way-member refs each relation declares, keyed by relation id, in the sequence served.
 * `assembleTrails` seeds `chainWays` on exactly this list.
 */
export function memberWaySequences(
  elements: readonly OverpassElement[],
): Map<number, readonly number[]> {
  const sequences = new Map<number, readonly number[]>();
  for (const element of elements) {
    if (element.type !== 'relation') continue;
    const wayRefs = (element.members ?? [])
      .filter((member) => member.type === 'way')
      .map((member) => member.ref);
    sequences.set(element.id, wayRefs);
  }
  return sequences;
}

/**
 * Top-level ways ordered by id ascending, which is what every recorded answer carries and what
 * assembly silently depends on. Checked rather than sorted, because sorting would let a source
 * pass parity in an order production would not give it.
 */
function assertTopLevelWaysAscending(elements: readonly OverpassElement[]): void {
  let previous = -Infinity;
  for (const element of elements) {
    if (element.type !== 'way') continue;
    if (element.id < previous) {
      throw new Error(
        `way ${element.id} arrives after way ${previous}: \`chainWays\` seeds greedily in ` +
          `iteration order and \`mergeTags\` votes in it, so top-level ways must reach ` +
          `\`assembleTrails\` ordered by way id ascending, as Overpass serves them. A relation's ` +
          `members are the other half of the contract and are not sorted — see ` +
          `\`assertMembersAsRecorded\`.`,
      );
    }
    previous = element.id;
  }
}

/**
 * Each relation's member sequence, held to the recording rather than to any sort. OSM stores
 * members in route order, so ascending is one of the ways to get this wrong and not the contract;
 * relations the recording does not carry are a content difference the diff shows, not an order one.
 */
function assertMembersAsRecorded(
  elements: readonly OverpassElement[],
  recorded: readonly OverpassElement[],
): void {
  const expected = memberWaySequences(recorded);
  for (const [id, served] of memberWaySequences(elements)) {
    const wanted = expected.get(id);
    if (!wanted || (served.length === wanted.length && served.every((r, i) => r === wanted[i]))) {
      continue;
    }
    throw new Error(
      `relation ${id} serves member ways [${served.join(', ')}] where the recording declares ` +
        `[${wanted.join(', ')}]: \`chainWays\` seeds greedily over a relation's members and ` +
        `\`mergeTags\` votes in that order, so the sequence must be preserved, not sorted. ` +
        `Rebuilding a relation from a member join needs \`ORDER BY ... WITH ORDINALITY\`.`,
    );
  }
}

/**
 * The parity contract: a candidate source's elements against the recording a golden was derived
 * from, comparable trails out. A source that replaces Overpass is correct exactly when this
 * returns the committed golden for the same ground.
 *
 * Order is part of the contract, not a property of the source to be absorbed, and its two halves
 * differ: top-level ways arrive by id ascending, a relation's members in the sequence OSM stores.
 * Assembly seeds on both, so a backend serving osm2pgsql's geometry-cluster order, or joining
 * member ways without `WITH ORDINALITY`, yields the right trail *count* built from different ways
 * — which is why either is refused rather than diffed.
 */
export function assembleAsRecorded(
  elements: readonly OverpassElement[],
  recorded: readonly OverpassElement[],
): AssembledTrailSummary[] {
  assertTopLevelWaysAscending(elements);
  assertMembersAsRecorded(elements, recorded);
  return summariseTrails(assembleTrails(elements));
}

/**
 * What assembly makes of a recording — the derivation a golden is written from. A recording is
 * the authority on member order, so there is nothing to hold it to; diff a candidate source
 * through `assembleAsRecorded`, which takes that authority as an argument.
 */
export function summariseRecording(recording: RawRecording): AssembledTrailSummary[] {
  const elements = recording.response.elements ?? [];
  assertTopLevelWaysAscending(elements);
  return summariseTrails(assembleTrails(elements));
}

export function goldenFile(shape: RawShape, subject: string): string {
  return join(RAW_FIXTURE_DIR, 'golden', `assemble.${shape}.${subject}.json`);
}

export function loadAssembleGolden(shape: RawShape, subject: string): AssembleGolden {
  return JSON.parse(readFileSync(goldenFile(shape, subject), 'utf8')) as AssembleGolden;
}
