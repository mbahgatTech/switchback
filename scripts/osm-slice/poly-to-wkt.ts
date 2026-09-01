/**
 * Area of a Geofabrik `.poly` in km², so a slice's bytes can be stated per unit of ground
 * rather than per download. Sections after the first are subtracted, per the format's spec.
 */

import { readFileSync } from 'node:fs';

function ringsOf(text: string): { outer: string[]; holes: string[] } {
  const lines = text.split(/\r?\n/);
  const outer: string[] = [];
  const holes: string[] = [];
  let current: number[][] | null = null;
  let isHole = false;

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === 'END') {
      if (current && current.length >= 3) {
        const ring = [...current];
        const [f] = ring;
        const l = ring[ring.length - 1]!;
        if (f![0] !== l[0] || f![1] !== l[1]) ring.push(f!);
        const wkt = `(${ring.map(([x, y]) => `${x} ${y}`).join(', ')})`;
        if (isHole) holes.push(wkt);
        else outer.push(wkt);
      }
      current = null;
      continue;
    }
    const coords = trimmed.match(/^(-?[\d.]+E?[+-]?\d*)\s+(-?[\d.]+E?[+-]?\d*)$/i);
    if (coords) {
      current ??= [];
      current.push([Number(coords[1]), Number(coords[2])]);
      continue;
    }
    if (trimmed.length > 0) {
      isHole = trimmed.startsWith('!');
      current = null;
    }
  }
  return { outer, holes };
}

const path = process.argv[2]!;
const { outer, holes } = ringsOf(readFileSync(path, 'utf8'));
const polygons = outer.map((o) => `POLYGON(${[o, ...holes].join(', ')})`);
console.log(
  polygons.length === 1 ? polygons[0] : `MULTIPOLYGON(${outer.map((o) => `(${o})`).join(', ')})`,
);
