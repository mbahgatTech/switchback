/**
 * The recorded Overpass answers this harness reads, and the trail summary a replacement source
 * is held to. Gzipped: a dense tile's answer is tens of megabytes of JSON.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { assembleTrails, type AssembledTrail } from '../../packages/ingest/src/assemble';
import type { OverpassElement, OverpassResponse } from '../../packages/ingest/src/overpass';

/*
 * The recordings are data, not code: the recorder on the fixture branch produces them and they
 * land under `packages/ingest/test/fixtures/raw`. Reading them through a local module rather than
 * importing that branch's test-support code is what lets every script here run against a plain
 * master checkout — timings and completeness need no recording at all, and a parity comparison
 * says so plainly when the directory is absent instead of dying on an unresolved import.
 */
export const RAW_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'ingest',
  'test',
  'fixtures',
  'raw',
);

/** The Overpass answer shapes this repository reads. Half of a recording's file name. */
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

export interface RawRecording {
  shape: RawShape;
  /** Quadkey, id, or joined id list — whatever the query was about, and half the file name. */
  subject: string;
  /** The QL as sent, so the recording can be reproduced without the recorder. */
  query: string;
  recordedAt: string;
  /**
   * `osm3s.timestamp_osm_base`: the instant of the planet the answer describes, which is the only
   * thing that dates the *data*. `recordedAt` dates the request, and the two differ by however far
   * behind the mirror was.
   */
  timestampOsmBase: string | null;
  response: OverpassResponse;
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
  shape: RawShape;
  subject: string;
  /** Copied from the recording, so a golden and a re-recording cannot drift apart unnoticed. */
  timestampOsmBase: string | null;
  trails: AssembledTrailSummary[];
}

export function digestCoords(coords: readonly (readonly [number, number])[]): CoordDigest {
  const hash = createHash('sha256');
  for (const [lng, lat] of coords) hash.update(`${lng.toFixed(7)},${lat.toFixed(7)};`);
  return { vertices: coords.length, sha256: hash.digest('hex') };
}

/**
 * The parity contract: elements in, comparable trails out. A source that replaces Overpass is
 * correct exactly when this returns the committed golden for the same ground.
 *
 * Sorted by identity because element order is a property of the source, not of assembly — a
 * different backend will not reproduce Overpass's ordering, and that difference is not a
 * divergence. Direction is deliberately *not* normalised: a reversed line is a real difference.
 */
export function assembleSummary(elements: readonly OverpassElement[]): AssembledTrailSummary[] {
  return assembleTrails(elements)
    .map(({ coords, ...rest }) => ({ ...rest, coords: digestCoords(coords) }))
    .sort(
      (a, b) =>
        a.osmType.localeCompare(b.osmType) ||
        a.osmId - b.osmId ||
        a.name.localeCompare(b.name) ||
        a.coords.sha256.localeCompare(b.coords.sha256),
    );
}

export function rawFixtureFile(shape: RawShape, subject: string): string {
  return `${shape}.${subject}.json.gz`;
}

export function goldenFile(shape: RawShape, subject: string): string {
  return join(RAW_FIXTURE_DIR, 'golden', `assemble.${shape}.${subject}.json`);
}

export function loadRawFixture(shape: RawShape, subject: string): RawRecording {
  const packed = readFileSync(join(RAW_FIXTURE_DIR, rawFixtureFile(shape, subject)));
  return JSON.parse(gunzipSync(packed).toString('utf8')) as RawRecording;
}

/** `null` when the recording set is not checked out, so a timing run is not lost to its absence. */
export function loadAssembleGolden(shape: RawShape, subject: string): AssembleGolden | null {
  const file = goldenFile(shape, subject);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as AssembleGolden;
}
