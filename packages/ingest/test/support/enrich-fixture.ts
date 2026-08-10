/**
 * The cached tile fixture the enrichment benchmark and parity tests read. Gzipped: the dense
 * tile's feature array is ~15 MB of JSON.
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BBox, LngLat } from '@switchback/core';
import type { OverpassElement } from '../../src/overpass';

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'enrich',
);

/** An assembled trail, reduced to what `attachWaypoints` and `terminusFeatures` actually read. */
export interface FixtureTrail {
  osmType: 'relation' | 'way';
  osmId: number;
  name: string;
  coords: LngLat[];
}

export interface EnrichFixture {
  quadkey: string;
  bbox: BBox;
  /** The padded box the feature query ran over — `featureSearchBBox(bbox)`. */
  featureBBox: BBox;
  fetchedAt: string;
  timestampOsmBase: string | null;
  vertexCount: number;
  trails: FixtureTrail[];
  features: OverpassElement[];
}

export function loadEnrichFixture(quadkey: string): EnrichFixture {
  const packed = readFileSync(join(FIXTURE_DIR, `${quadkey}.json.gz`));
  return JSON.parse(gunzipSync(packed).toString('utf8')) as EnrichFixture;
}
