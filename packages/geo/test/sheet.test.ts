import { describe, expect, it } from 'vitest';
import type { BBox } from '@switchback/core';
import {
  MM_PER_CSS_PX,
  SHEET_DEFAULT_SCALE,
  SHEET_SCALES,
  type SheetFrame,
  type SheetSizeMm,
  fitSheetScale,
  formatDegrees,
  formatScale,
  paperSizeMm,
  sheetBBox,
  sheetBarScale,
  sheetCentre,
  sheetCoverageM,
  sheetFits,
  sheetGraticule,
  sheetLngLat,
  sheetMetresPerPx,
  sheetPointMm,
  sheetScaleDenominator,
  sheetWorldMm,
  sheetZoom,
} from '@switchback/geo';

/**
 * The thing worth protecting here is that the number printed in the collar is true.
 *
 * A sheet claiming 1:25 000 is a claim the reader can check with a ruler, and it degrades
 * worse than anything else in this product when it is slightly wrong: a bearing measured off
 * a sheet whose scale is out hikes somebody into the wrong valley, and nothing on the paper
 * shows that it happened. So the load-bearing assertions below invert the whole chain
 * independently — millimetres of paper back to metres of ground, by formulas written out
 * differently from the ones in the module — rather than agreeing with the module's own
 * arithmetic.
 */

/** The map face on a landscape A4 sheet, roughly what the print route lays out. */
const FACE: SheetSizeMm = { widthMm: 260, heightMm: 150 };

/** Mount Assiniboine, the route every probe in this repo flies. */
const ASSINIBOINE: [number, number] = [-115.66782, 50.87833];

/** MapLibre's world is 512 px at zoom 0, so this is its zoom-0 ground resolution. */
const EQUATOR_M_PER_PX = 78_271.516_964;

/** Metres per degree of longitude at the test latitude, derived here rather than imported. */
const M_PER_DEG_LNG = (40_075_016.686 * Math.cos((ASSINIBOINE[1] * Math.PI) / 180)) / 360;

function frameAt(denominator: number, face: SheetSizeMm = FACE): SheetFrame {
  return { centre: ASSINIBOINE, denominator, face };
}

describe('sheetMetresPerPx', () => {
  it('turns a ratio into ground metres per CSS pixel', () => {
    // A CSS pixel is a 96th of an inch by definition, so at 1:25 000 it covers 25 000 ×
    // 0.2646 mm of ground — 6.61 m. Get this wrong and every printed distance is wrong by
    // the same factor, silently, because the map still looks exactly like a map.
    expect(sheetMetresPerPx(25_000)).toBeCloseTo((25_000 * 25.4) / 96 / 1_000, 9);
    expect(sheetMetresPerPx(25_000)).toBeCloseTo(6.614_583, 5);
    expect(MM_PER_CSS_PX).toBeCloseTo(0.264_583_333, 9);
  });
});

describe('sheetZoom', () => {
  it('lands where an independent inversion of MapLibre puts it', () => {
    const zoom = sheetZoom(25_000, ASSINIBOINE[1]);
    const mPerPx = (EQUATOR_M_PER_PX * Math.cos((ASSINIBOINE[1] * Math.PI) / 180)) / 2 ** zoom;
    expect(mPerPx).toBeCloseTo(sheetMetresPerPx(25_000), 9);
  });

  it('round-trips against the ratio it came from', () => {
    for (const denominator of SHEET_SCALES) {
      for (const lat of [0, 34.2, 50.878, -41.3, 68]) {
        expect(sheetScaleDenominator(sheetZoom(denominator, lat), lat)).toBeCloseTo(denominator, 3);
      }
    }
  });

  it('pulls back nearer the poles, where a Mercator pixel covers less ground', () => {
    // The same printed ratio needs a smaller zoom number further north, because the
    // projection has already magnified the ground. A sheet ignoring this is out by a third at
    // Scottish latitudes and by half in Iceland.
    expect(sheetZoom(25_000, 60)).toBeLessThan(sheetZoom(25_000, 0));
    expect(sheetZoom(25_000, 60)).toBeCloseTo(
      sheetZoom(25_000, 0) + Math.log2(Math.cos(Math.PI / 3)),
      9,
    );
  });

  it('halving the ratio is exactly one zoom level', () => {
    expect(sheetZoom(12_500, 50)).toBeCloseTo(sheetZoom(25_000, 50) + 1, 9);
  });

  it('refuses to divide by a ratio of zero', () => {
    expect(sheetZoom(0, 50)).toBe(0);
    expect(sheetWorldMm(0, 50)).toBe(0);
    expect(sheetWorldMm(-1, 50)).toBe(0);
  });
});

describe('sheetPointMm', () => {
  it('puts the sheet centre at the middle of the face', () => {
    const [x, y] = sheetPointMm(ASSINIBOINE, frameAt(25_000));
    expect(x).toBeCloseTo(FACE.widthMm / 2, 9);
    expect(y).toBeCloseTo(FACE.heightMm / 2, 9);
  });

  it('places a kilometre of ground at the millimetres the ratio promises', () => {
    // Due east of the centre by 1 km, offset using the length of a degree of longitude rather
    // than anything the module knows. At 1:25 000 it must land exactly 40 mm right of the
    // middle — precisely the claim the collar makes, in the one form a ruler can check.
    const east: [number, number] = [ASSINIBOINE[0] + 1_000 / M_PER_DEG_LNG, ASSINIBOINE[1]];
    expect(sheetPointMm(east, frameAt(25_000))[0] - FACE.widthMm / 2).toBeCloseTo(40, 6);
    // And the same kilometre is 20 mm on a sheet at half the scale.
    expect(sheetPointMm(east, frameAt(50_000))[0] - FACE.widthMm / 2).toBeCloseTo(20, 6);
  });

  it('round-trips through the paper and back', () => {
    const frame = frameAt(40_000);
    const samples: Array<[number, number]> = [
      [0, 0],
      [FACE.widthMm, FACE.heightMm],
      [17.5, 122.25],
    ];
    for (const [x, y] of samples) {
      const [rx, ry] = sheetPointMm(sheetLngLat(x, y, frame), frame);
      expect(rx).toBeCloseTo(x, 6);
      expect(ry).toBeCloseTo(y, 6);
    }
  });

  it('lets a route run off the sheet rather than clamping it to the neatline', () => {
    // A clamped point draws the trail along the edge of the map, which reads as a path
    // following the border of the page — the one line on a sheet that is definitely not
    // terrain. Off the paper is the honest answer, and the caller can then say so out loud.
    const [x] = sheetPointMm([ASSINIBOINE[0] + 2, ASSINIBOINE[1]], frameAt(25_000));
    expect(x).toBeGreaterThan(FACE.widthMm);
  });

  it('rounds the short way across the antimeridian', () => {
    // Two hundredths of a degree away, not three hundred and sixty degrees away.
    const frame: SheetFrame = { centre: [179.99, 0], denominator: 25_000, face: FACE };
    const [x] = sheetPointMm([-179.99, 0], frame);
    expect(x).toBeGreaterThan(FACE.widthMm / 2);
    expect(x - FACE.widthMm / 2).toBeCloseTo((0.02 * 40_075_016.686) / 360 / 25, 3);
  });
});

describe('sheetBBox and sheetCoverageM', () => {
  it('covers the ground the ratio says it covers', () => {
    const frame = frameAt(25_000);
    const { widthM, heightM } = sheetCoverageM(frame);
    // 260 mm at 1:25 000 is 6.5 km, by definition of the ratio.
    expect(widthM).toBeCloseTo(6_500, 6);
    expect(heightM).toBeCloseTo(3_750, 6);

    const [west, south, east, north] = sheetBBox(frame);
    expect((east - west) * M_PER_DEG_LNG).toBeCloseTo(widthM, 3);
    // Latitude is the loose one: Mercator's scale changes across the face, so the north–south
    // ground span only equals the nominal coverage at the centre. Out by centimetres here.
    expect(((north - south) * 40_075_016.686) / 360).toBeCloseTo(heightM, 0);
  });

  it('puts the centre back in the middle', () => {
    const bbox = sheetBBox(frameAt(50_000));
    expect((bbox[0] + bbox[2]) / 2).toBeCloseTo(ASSINIBOINE[0], 9);
    expect(sheetCentre(bbox)[1]).toBeCloseTo(ASSINIBOINE[1], 6);
  });

  it('degrades to the centre point rather than NaN on a ratio of zero', () => {
    expect(sheetLngLat(10, 10, frameAt(0))).toEqual(ASSINIBOINE);
  });
});

describe('sheetCentre', () => {
  /** Isometric latitude, written the other way round from the module's `ln(tan + sec)`. */
  const isoY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const isoLat = (y: number): number =>
    ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

  it('takes the projected middle, not the average of two latitudes', () => {
    // A box from 45° to 55° has its paper midpoint above 50°, because Mercator spaces the
    // northern degrees further apart. Averaging gives 50.0 and puts a fitted route a few
    // millimetres high on the sheet — enough to clip one edge while leaving white at the other.
    const centre = sheetCentre([-1, 45, 1, 55]);
    expect(centre[0]).toBeCloseTo(0, 9);
    expect(centre[1]).toBeCloseTo(isoLat((isoY(45) + isoY(55)) / 2), 9);
    expect(centre[1]).toBeGreaterThan(50.2);
    expect(centre[1]).toBeLessThan(50.3);
  });

  it('is unremarkable at the equator, where the projection is not doing anything', () => {
    const centre = sheetCentre([-2, -3, 4, 3]);
    expect(centre[0]).toBeCloseTo(1, 9);
    expect(centre[1]).toBeCloseTo(0, 9);
  });
});

describe('fitSheetScale', () => {
  /** The ground a frame exactly covers — so the expected answer is arithmetic, not a guess. */
  function bboxCovering(denominator: number): BBox {
    // The face `fitSheetScale` tests against, once the default margin is taken off both edges.
    const usable: SheetSizeMm = { widthMm: FACE.widthMm - 10, heightMm: FACE.heightMm - 10 };
    return sheetBBox({ centre: ASSINIBOINE, denominator, face: usable });
  }

  it('picks the largest scale on the ladder that still holds the route', () => {
    // A route just inside what 1:25 000 covers must come back as 1:25 000: one rung finer and
    // it would not fit, and any coarser is detail thrown away for nothing.
    expect(fitSheetScale(bboxCovering(24_900), FACE)).toBe(25_000);
    expect(fitSheetScale(bboxCovering(14_900), FACE)).toBe(15_000);
    // A hair too big for 15 000 steps down to the next rung, not to a made-up ratio.
    expect(fitSheetScale(bboxCovering(15_100), FACE)).toBe(25_000);
  });

  it('only ever returns a ratio off the ladder', () => {
    for (const size of [0.002, 0.02, 0.2, 2, 20]) {
      expect(SHEET_SCALES).toContain(fitSheetScale([-size, 50 - size, size, 50 + size], FACE));
    }
    expect(SHEET_SCALES).toContain(SHEET_DEFAULT_SCALE);
  });

  it('honours the margin, so nothing is drawn onto the neatline', () => {
    const bbox = bboxCovering(24_900);
    expect(fitSheetScale(bbox, FACE, { marginMm: 0 })).toBe(25_000);
    expect(fitSheetScale(bbox, FACE, { marginMm: 20 })).toBeGreaterThan(25_000);
  });

  it('falls through to the coarsest rung for a route that does not go on a page', () => {
    // The Pacific Crest Trail is 4,265 km of this database and there is no honest sheet for
    // it. The caller is expected to notice via `sheetFits` and say so, rather than print a
    // ratio that is a lie.
    const pct: BBox = [-121, 32.6, -116.4, 49];
    const denominator = fitSheetScale(pct, FACE);
    expect(denominator).toBe(SHEET_SCALES[SHEET_SCALES.length - 1]);
    expect(sheetFits({ centre: sheetCentre(pct), denominator, face: FACE }, pct)).toBe(false);
  });

  it('takes a caller-supplied ladder, and ignores an empty one', () => {
    const bbox = bboxCovering(24_900);
    expect(fitSheetScale(bbox, FACE, { scales: [50_000, 10_000] })).toBe(50_000);
    expect(fitSheetScale(bbox, FACE, { scales: [] })).toBe(25_000);
  });
});

describe('sheetBarScale', () => {
  it('spans a round number of metres, never a fitted one', () => {
    // 60 mm at 1:25 000 is 1.5 km of ground, and 1.5 km is not a distance anyone divides by
    // eye. The bar is 1 km and stops short of the space available.
    expect(sheetBarScale(25_000, 60)).toEqual({ groundM: 1_000, lengthMm: 40, rungs: 4 });
    expect(sheetBarScale(50_000, 60)).toEqual({ groundM: 2_000, lengthMm: 40, rungs: 4 });
    expect(sheetBarScale(100_000, 60)).toEqual({ groundM: 5_000, lengthMm: 50, rungs: 5 });
  });

  it('never draws past the space it was given, or shrinks to a stub', () => {
    for (const denominator of SHEET_SCALES) {
      for (const maxMm of [18, 40, 60, 95]) {
        const bar = sheetBarScale(denominator, maxMm);
        expect(bar.lengthMm).toBeLessThanOrEqual(maxMm);
        expect(bar.lengthMm).toBeGreaterThan(maxMm / 3);
        // And the bar means what it says: its paper length is its ground length at the ratio.
        expect((bar.groundM * 1_000) / denominator).toBeCloseTo(bar.lengthMm, 9);
      }
    }
  });

  it('divides into rungs a reader can halve in their head', () => {
    for (const denominator of SHEET_SCALES) {
      const bar = sheetBarScale(denominator, 60);
      const rung = bar.groundM / bar.rungs;
      // 100, 250 or 500 times a power of ten — no thirds, no sevenths.
      const mantissa = rung / 10 ** Math.floor(Math.log10(rung));
      expect([1, 2.5, 5]).toContain(Number(mantissa.toFixed(6)));
    }
  });

  it('returns nothing to draw rather than a NaN when there is no room', () => {
    expect(sheetBarScale(25_000, 0)).toEqual({ groundM: 0, lengthMm: 0, rungs: 0 });
    expect(sheetBarScale(0, 60)).toEqual({ groundM: 0, lengthMm: 0, rungs: 0 });
    expect(sheetBarScale(Number.NaN, 60).groundM).toBe(0);
  });
});

describe('sheetGraticule', () => {
  it('rules in minutes and seconds, because that is how the labels read', () => {
    const graticule = sheetGraticule(frameAt(25_000));
    // Two minutes across a 6.5 km sheet — three or four meridians, not a texture.
    expect(graticule.intervalDeg).toBeCloseTo(2 / 60, 9);
    expect(graticule.meridians.length).toBeGreaterThanOrEqual(2);
    expect(graticule.meridians.length).toBeLessThanOrEqual(5);
    expect(graticule.parallels.length).toBeGreaterThanOrEqual(1);
  });

  it('subdivides rather than replaces as the sheet zooms in', () => {
    const coarse = sheetGraticule(frameAt(100_000)).intervalDeg;
    const fine = sheetGraticule(frameAt(10_000)).intervalDeg;
    expect(fine).toBeLessThan(coarse);
    // Every rung divides its neighbour, so the finer sheet's lines include the coarser's and
    // a reader stepping between two scales is not re-learning the frame.
    expect(Math.round((coarse / fine) * 1e6) % 1e6).toBe(0);
  });

  it('places every line inside the face, in order, at every scale offered', () => {
    for (const denominator of SHEET_SCALES) {
      const frame = frameAt(denominator);
      const { meridians, parallels } = sheetGraticule(frame);
      expect(meridians.length).toBeGreaterThan(0);
      expect(parallels.length).toBeGreaterThan(0);

      for (const line of meridians) {
        expect(line.mm).toBeGreaterThanOrEqual(-1e-6);
        expect(line.mm).toBeLessThanOrEqual(frame.face.widthMm + 1e-6);
      }
      for (const line of parallels) {
        expect(line.mm).toBeGreaterThanOrEqual(-1e-6);
        expect(line.mm).toBeLessThanOrEqual(frame.face.heightMm + 1e-6);
      }
      for (let i = 1; i < meridians.length; i += 1) {
        expect(meridians[i]!.deg).toBeGreaterThan(meridians[i - 1]!.deg);
        expect(meridians[i]!.mm).toBeGreaterThan(meridians[i - 1]!.mm);
      }
      // North is up, so a parallel further north sits further up the page.
      for (let i = 1; i < parallels.length; i += 1) {
        expect(parallels[i]!.deg).toBeGreaterThan(parallels[i - 1]!.deg);
        expect(parallels[i]!.mm).toBeLessThan(parallels[i - 1]!.mm);
      }
    }
  });

  it('drops a rung rather than leaving the short axis unruled', () => {
    /*
     * A 260 × 150 mm face at 1:40 000 covers 8′53″ of longitude and 3′14″ of latitude, so the
     * 5′ interval the wider axis asks for does not fit between the top and bottom of the sheet
     * at all. Sized off the wide axis alone, this sheet prints meridians and no parallels.
     */
    const frame = frameAt(40_000);
    const { intervalDeg, meridians, parallels } = sheetGraticule(frame);
    expect(intervalDeg).toBeCloseTo(2 / 60, 9);
    expect(parallels.length).toBeGreaterThan(0);
    expect(meridians.length).toBeGreaterThan(parallels.length);
  });

  it('labels each line with the coordinate it actually sits on', () => {
    const frame = frameAt(50_000);
    const { meridians, parallels } = sheetGraticule(frame);
    for (const line of meridians) {
      expect(line.label).toBe(formatDegrees(line.deg, 'lng'));
      expect(sheetLngLat(line.mm, 0, frame)[0]).toBeCloseTo(line.deg, 6);
    }
    for (const line of parallels) {
      expect(line.label).toBe(formatDegrees(line.deg, 'lat'));
      expect(sheetLngLat(0, line.mm, frame)[1]).toBeCloseTo(line.deg, 6);
    }
  });

  it('stays sparse on a sheet covering a continent', () => {
    const graticule = sheetGraticule(frameAt(2_500_000));
    expect(graticule.meridians.length).toBeLessThan(20);
    expect(graticule.parallels.length).toBeLessThan(20);
  });
});

describe('formatDegrees', () => {
  it('drops the components that are zero', () => {
    expect(formatDegrees(50, 'lat')).toBe('50°N');
    expect(formatDegrees(50.5, 'lat')).toBe('50°30′N');
    expect(formatDegrees(50 + 30 / 60 + 30 / 3_600, 'lat')).toBe('50°30′30″N');
  });

  it('pads minutes and seconds, so a column of labels lines up', () => {
    expect(formatDegrees(50 + 4 / 60, 'lat')).toBe('50°04′N');
    expect(formatDegrees(50 + 4 / 60 + 7 / 3_600, 'lat')).toBe('50°04′07″N');
  });

  it('says which hemisphere rather than printing a minus sign', () => {
    expect(formatDegrees(-50, 'lat')).toBe('50°S');
    expect(formatDegrees(-115.66782, 'lng')).toBe('115°40′04″W');
    expect(formatDegrees(115.66782, 'lng')).toBe('115°40′04″E');
    expect(formatDegrees(0, 'lng')).toBe('0°E');
    expect(formatDegrees(0, 'lat')).toBe('0°N');
  });

  it('carries a rounded sixty seconds into the minute above it', () => {
    // 50.99999° is 3 599.96 seconds past 50°, which rounds to a whole degree — printing
    // "50°59′60″" would be a coordinate that does not exist.
    expect(formatDegrees(50.99999, 'lat')).toBe('51°N');
    expect(formatDegrees(50.508333 - 1e-7, 'lat')).toBe('50°30′30″N');
  });
});

describe('formatScale', () => {
  /** The cartographic thousands separator, spelled out so this file has no invisible bytes. */
  const THIN = '\u2009';

  it('groups the thousands the way a collar does', () => {
    // A thin space rather than a comma, which half the world reads as a decimal point.
    expect(formatScale(25_000)).toBe(`1:25${THIN}000`);
    expect(formatScale(2_500_000)).toBe(`1:2${THIN}500${THIN}000`);
    expect(formatScale(5_000)).toBe(`1:5${THIN}000`);
    expect(formatScale(900)).toBe('1:900');
    expect(formatScale(25_000)).not.toContain(',');
    expect(formatScale(25_000)).not.toContain(' ');
  });
});

describe('paperSizeMm', () => {
  it('swaps the axes rather than keeping two sets of numbers', () => {
    expect(paperSizeMm('a4', 'portrait')).toEqual({ widthMm: 210, heightMm: 297 });
    expect(paperSizeMm('a4', 'landscape')).toEqual({ widthMm: 297, heightMm: 210 });
    expect(paperSizeMm('letter', 'portrait')).toEqual({ widthMm: 215.9, heightMm: 279.4 });
    expect(paperSizeMm('letter', 'landscape')).toEqual({ widthMm: 279.4, heightMm: 215.9 });
  });
});
