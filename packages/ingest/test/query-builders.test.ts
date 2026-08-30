/**
 * Which builder a recorded answer is filed under, decided by the syntax a query is written in
 * rather than by the name on the nearest line above it.
 */

import { describe, expect, it } from 'vitest';
import { overpassShapesIn, overpassShapesInSource } from './support/query-builders';

const FILE = 'packages/ingest/src/overpass.ts';

/** The shape of a real builder, so every case below sits after one that already resolves. */
const TILE_BUILDER = [
  'export function buildTileQuery(bbox: number[]): string {',
  '  const box = `${bbox[1]},${bbox[0]}`;',
  '  return `[out:json][timeout:180];',
  'way["highway"](${box});',
  'out body geom;`;',
  '}',
].join('\n');

function shapes(...declarations: string[]): string[] {
  return overpassShapesIn([TILE_BUILDER, ...declarations].join('\n\n'), FILE);
}

describe('a query written as a plain function', () => {
  it('is filed under the answer its name spells out', () => {
    expect(shapes()).toEqual(['tile']);
  });

  it('keeps its QL when an inner constant holds part of the query', () => {
    expect(
      shapes(
        'export function buildRegionQuery(at: number[]): string {',
        '  const here = `is_in(${at[1]},${at[0]})->.here;`;',
        "  return '[out:json][timeout:60];' + here + 'out tags;';",
        '}',
      ),
    ).toEqual(['tile', 'region']);
  });
});

describe('a query written somewhere a line-based reading cannot see', () => {
  /**
   * The failure this guard exists to stop: QL under a name that is not a builder's is credited
   * to the builder above it, and a live answer with no recording and no golden ships green.
   */
  it('is refused rather than credited to the builder above it', () => {
    expect(() =>
      shapes(
        'export class TrailheadQueries {',
        '  parkingNear(bbox: number[]): string {',
        '    return \'[out:json][timeout:60];\\nnwr["amenity"="parking"];\\nout center;\';',
        '  }',
        '}',
      ),
    ).toThrow(/`parkingNear` builds Overpass QL but is not named/u);
  });

  it('is refused when the function has no name at all', () => {
    expect(() =>
      shapes(
        'export default function (ids: number[]): string {',
        "  return '[out:json][timeout:60];\\nrelation(id:1);\\nout tags;';",
        '}',
      ),
    ).toThrow(/Overpass QL under no named declaration/u);
  });

  it('is refused when it is a bare constant belonging to no builder', () => {
    expect(() => shapes("const PING = '[out:json];';")).toThrow(
      /`PING` builds Overpass QL but is not named/u,
    );
  });
});

describe('a query written under a name a builder may legitimately carry', () => {
  it('reads through an arrow bound with `let`', () => {
    expect(
      shapes("export let buildWayGeometryQuery = (ids: number[]) => '[out:json];\\nway(id:1);';"),
    ).toEqual(['tile', 'way-geometry']);
  });

  it('reads through an object property', () => {
    expect(
      shapes('export const queries = {', "  routeQuery: () => '[out:json];\\nrelation(1);',", '};'),
    ).toEqual(['tile', 'route']);
  });

  it('reads through a class method', () => {
    expect(
      shapes(
        'class Lookups {',
        "  parentRouteQuery(): string {\n    return '[out:json];';\n  }",
        '}',
      ),
    ).toEqual(['tile', 'parent-route']);
  });
});

describe('Overpass QL quoted rather than sent', () => {
  /** A comment is not a query, and neither is prose about one. */
  it('is not counted as an answer the repository asks for', () => {
    expect(
      shapes('// The tile query opens `[out:json][timeout:180]` and nothing else does.'),
    ).toEqual(['tile']);
  });
});

describe('the repository as it stands', () => {
  /**
   * The shapes the walk finds, listed once so an unrecorded builder is visible here as well as
   * through the recording index. Every one has a recording under `fixtures/raw/`.
   */
  it('asks for nine answer shapes', async () => {
    await expect(overpassShapesInSource()).resolves.toEqual([
      'feature',
      'network',
      'parent-route',
      'region',
      'relation-skeleton',
      'route',
      'tags-by-id',
      'tile',
      'way-geometry',
    ]);
  });
});
