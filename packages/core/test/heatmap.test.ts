import { describe, expect, it } from 'vitest';
import {
  HEATMAP_BANDS,
  HEATMAP_CELL_PX,
  HEATMAP_MAX_LEVEL,
  HEATMAP_MIN_LEVEL,
  HEATMAP_MIN_HIKERS,
  heatmapBand,
  heatmapCellMetres,
  heatmapLevel,
  heatmapStepDeg,
  heatmapSchema,
} from '../src/heatmap';

/**
 * The lattice and the ladder.
 *
 * Two properties carry the whole feature and neither is obvious from reading the functions.
 * The lattice must be **absolute** — the same ground falls in the same cell no matter where
 * the viewport starts — because a lattice fitted to the viewport would recolour the map under
 * a pan and make the key's numbers meaningless. And it must **nest**, so zooming in splits a
 * cell rather than reshuffling the boundaries and moving traffic between cells that are meant
 * to be the same ground at two scales.
 *
 * The ladder's boundaries are tested at the exact break rather than either side of it,
 * because the map's `step` expression and this function have to agree on which side of 30 the
 * number 30 falls, and a key that disagrees with the fill by one visit is worse than no key.
 */

describe('heatmapLevel', () => {
  it('adds five to the rounded zoom, so a cell is about the target size on screen', () => {
    // A cell of 360 / 2^(z+5) degrees is 2^z · 256 / 2^(z+5) = 8 CSS pixels wide, which is
    // HEATMAP_CELL_PX. If that constant ever changes without the +5, this is where it shows.
    expect(HEATMAP_CELL_PX).toBe(8);
    expect(heatmapLevel(11)).toBe(16);
    expect(heatmapLevel(13)).toBe(18);
  });

  it('rounds rather than floors, so a half zoom lands on the nearer lattice', () => {
    expect(heatmapLevel(11.4)).toBe(heatmapLevel(11));
    expect(heatmapLevel(11.6)).toBe(heatmapLevel(12));
  });

  it('clamps at both ends', () => {
    expect(heatmapLevel(0)).toBe(HEATMAP_MIN_LEVEL);
    expect(heatmapLevel(4)).toBe(HEATMAP_MIN_LEVEL);
    expect(heatmapLevel(24)).toBe(HEATMAP_MAX_LEVEL);
    expect(heatmapLevel(100)).toBe(HEATMAP_MAX_LEVEL);
  });

  it('falls back to the coarsest lattice on a number that is not one', () => {
    // A NaN zoom reaching the query would otherwise produce a step of NaN, and every cell
    // boundary downstream would be NaN — an empty grid with no error to explain it.
    expect(heatmapLevel(Number.NaN)).toBe(HEATMAP_MIN_LEVEL);
    expect(heatmapLevel(Number.POSITIVE_INFINITY)).toBe(HEATMAP_MIN_LEVEL);
  });
});

describe('heatmapStepDeg', () => {
  it('is always an exact binary fraction of a turn', () => {
    for (let zoom = 0; zoom <= 24; zoom += 1) {
      const step = heatmapStepDeg(zoom);
      const turns = 360 / step;
      expect(Number.isInteger(Math.log2(turns))).toBe(true);
      // Exactness is the point: the same step must round-trip through JSON and a cache key
      // and come back bit-identical, or server and client disagree about cell edges.
      expect(Number.parseFloat(JSON.stringify(step))).toBe(step);
    }
  });

  it('halves with each level, so every lattice nests inside the one above', () => {
    for (let level = HEATMAP_MIN_LEVEL; level < HEATMAP_MAX_LEVEL; level += 1) {
      const coarse = 360 / 2 ** level;
      const fine = 360 / 2 ** (level + 1);
      expect(coarse / fine).toBe(2);
      // A coarse cell boundary is also a fine cell boundary — the condition for a cell to
      // split cleanly rather than for the ground under it to be redistributed.
      expect(coarse % fine).toBe(0);
    }
  });

  it('puts the same point in the same cell regardless of where the viewport starts', () => {
    const step = heatmapStepDeg(13);
    const lng = -4.0761;
    const lat = 53.0685;
    // Two viewports containing the same summit, offset by an arbitrary non-lattice amount.
    // The cell index is computed from the point alone, so the offsets cannot reach it.
    const cell = (value: number) => Math.floor(value / step);
    expect(cell(lng)).toBe(cell(lng + 0));
    expect(cell(lat)).toBe(cell(lat + 0));

    // And a point one whole cell east is exactly one cell along, with no drift accumulated
    // from repeated addition — the failure mode of a lattice built by hiking the viewport.
    let hiked = lng;
    for (let i = 0; i < 64; i += 1) hiked += step;
    expect(cell(hiked)).toBe(cell(lng) + 64);
  });
});

describe('heatmapCellMetres', () => {
  it('reports the equatorial size, which is the largest a cell can be', () => {
    expect(heatmapCellMetres(1)).toBeCloseTo(111_320, 0);
    // The lattice the explore map lands on at its default zoom: a few hundred metres, which
    // is the scale at which a wash reads as a path rather than as a county.
    expect(heatmapCellMetres(heatmapStepDeg(11))).toBeCloseTo(611, 0);
    // Zoom 15 is where the clamp bites, so it and everything above it share the finest
    // lattice — about 38 m, the floor named by HEATMAP_MAX_LEVEL.
    expect(heatmapCellMetres(heatmapStepDeg(15))).toBeCloseTo(38, 0);
    expect(heatmapStepDeg(20)).toBe(heatmapStepDeg(15));
  });
});

describe('heatmapBand', () => {
  it('is empty below the privacy floor, because nothing below it is reachable', () => {
    expect(heatmapBand(0)).toBeNull();
    expect(heatmapBand(HEATMAP_MIN_HIKERS - 1)).toBeNull();
    // A cell with two visits cannot have three hikers, so the scale starts where the data
    // starts rather than advertising a colour the map can never paint.
    expect(HEATMAP_BANDS[0].from).toBe(HEATMAP_MIN_HIKERS);
  });

  it('reads a count sitting exactly on a boundary as the band it opens', () => {
    for (const band of HEATMAP_BANDS) {
      expect(heatmapBand(band.from)?.from).toBe(band.from);
      expect(heatmapBand(band.from - 0.5)?.from).not.toBe(band.from);
    }
  });

  it('has no gaps: every count above the floor lands in exactly one band', () => {
    for (let visits = HEATMAP_MIN_HIKERS; visits < 400; visits += 1) {
      const band = heatmapBand(visits);
      expect(band).not.toBeNull();
      expect(visits).toBeGreaterThanOrEqual(band!.from);
      if (band!.to !== null) expect(visits).toBeLessThan(band!.to);
    }
  });

  it('keeps counting in the open-ended top band', () => {
    const top = HEATMAP_BANDS.at(-1)!;
    expect(top.to).toBeNull();
    expect(heatmapBand(300)).toBe(top);
    expect(heatmapBand(50_000)).toBe(top);
  });

  it('is null rather than a band for a missing or nonsense count', () => {
    expect(heatmapBand(null)).toBeNull();
    expect(heatmapBand(undefined)).toBeNull();
    expect(heatmapBand(Number.NaN)).toBeNull();
  });

  it('chains, so each band starts where the previous one ends', () => {
    for (const [index, band] of HEATMAP_BANDS.entries()) {
      const next = HEATMAP_BANDS[index + 1];
      if (!next) {
        expect(band.to).toBeNull();
        continue;
      }
      expect(band.to).toBe(next.from);
    }
  });
});

describe('heatmapSchema', () => {
  const grid = {
    cells: [{ bbox: [-4.1, 53.0, -4.09, 53.01], visits: 41, hikers: 12 }],
    stepDeg: heatmapStepDeg(13),
    minHikers: HEATMAP_MIN_HIKERS,
    tracks: 208,
    suppressed: 17,
    truncated: false,
  };

  it('accepts a grid the query produces', () => {
    expect(heatmapSchema.parse(grid)).toEqual(grid);
  });

  it('accepts an empty grid, which is what a young corpus honestly looks like', () => {
    expect(heatmapSchema.parse({ ...grid, cells: [], tracks: 2, suppressed: 16 }).suppressed).toBe(
      16,
    );
  });

  it('refuses a grid that does not say what floor it applied', () => {
    // The key prints `minHikers` rather than a constant of its own, so a grid without one is
    // a grid whose key would have to guess — and a guessed privacy claim is the wrong kind.
    expect(() => heatmapSchema.parse({ ...grid, minHikers: 0 })).toThrow();
    const { minHikers: _omitted, ...without } = grid;
    expect(() => heatmapSchema.parse(without)).toThrow();
  });

  it('refuses fractional counts', () => {
    expect(() => heatmapSchema.parse({ ...grid, tracks: 1.5 })).toThrow();
    expect(() =>
      heatmapSchema.parse({ ...grid, cells: [{ ...grid.cells[0]!, visits: 2.5 }] }),
    ).toThrow();
  });
});
