import { describe, expect, it } from 'vitest';
import type { ElevationPoint } from '@switchback/core';
import { axisDistance, axisElevation } from '@switchback/core';
import {
  type CalloutPlacement,
  type SectionPoint,
  elevationAt,
  elevationTicks,
  formatElapsed,
  placeCallouts,
  positionAt,
  sampleSection,
  sectionAreaPath,
  sectionBands,
  sectionLinePoints,
  sectionScale,
  toSectionPoints,
  toStations,
} from '@switchback/geo';

/**
 * The section's projection, which two renderers now share.
 *
 * `apps/web/src/components/section.tsx` and `apps/mobile/src/components/section.tsx` both
 * draw from these functions and neither re-derives a curve, so a change here moves the
 * graphic on the website and on the phone at once. That is the reason for the last block
 * below: the two plots have different rectangles, different units and different type sizes,
 * and the one thing that must survive all of it is that they are the same drawing.
 */

/** A profile with a given spacing and an elevation function of distance. */
function profileOf(
  spacingM: number,
  count: number,
  eleAt: (distM: number) => number,
): ElevationPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    distM: i * spacingM,
    eleM: eleAt(i * spacingM),
    lng: -4 + i * 0.001,
    lat: 53,
  }));
}

/** 5 km at 25 m spacing, climbing to a single summit two-thirds along and dropping back. */
const PEAK = profileOf(25, 201, (d) => 200 + 600 * Math.sin((Math.PI * d) / 5000));

/**
 * The Pacific Crest Trail's length, at a spacing that keeps the fixture cheap.
 *
 * 4,270 km is three orders of magnitude past the day hike everything else here tests, and
 * it is where the station ladder used to run out: the old one stopped at 50 km, so `find`
 * returned nothing, the fallback took over at its top rung, and the axis drew eighty-five
 * labels into a solid band of overprinted digits.
 */
const THRU_HIKE = profileOf(10_000, 428, (d) => 1000 + 500 * Math.sin(d / 250_000));

/**
 * The American Perimeter Trail, at 7,681 km the longest walkable route there is.
 *
 * The Pacific Crest Trail fits under a 1,000 km rung and this does not, which is the whole
 * reason it is here: a ladder tested only against the trail that prompted it will be
 * exactly one rung too short for the trail nobody thought of.
 */
const PERIMETER = profileOf(20_000, 385, (d) => 400 + 400 * Math.sin(d / 400_000));

/** The heights each system's ladder is asked to cover: a dune, a fell, a Nepali summit. */
const SUMMITS = [40, 300, 1085, 4810, 8849];

describe('toSectionPoints', () => {
  it('passes a short profile through untouched', () => {
    const profile = profileOf(25, 40, () => 100);
    expect(toSectionPoints(profile)).toHaveLength(40);
  });

  it('keeps the summit and the low point when it thins', () => {
    // A stride that lands on neither extreme is the case this exists for: a section whose
    // high point is lower than the stat block above it is worse than no section at all.
    const profile = profileOf(25, 401, (d) => (d === 25 * 137 ? 999 : d === 25 * 202 ? 3 : 500));
    const points = toSectionPoints(profile, { maxPoints: 60 });

    expect(Math.max(...points.map((p) => p.elevationM))).toBe(999);
    expect(Math.min(...points.map((p) => p.elevationM))).toBe(3);
  });

  it('thins to roughly the requested count and keeps both ends', () => {
    const points = toSectionPoints(PEAK, { maxPoints: 50 });
    expect(points.length).toBeLessThanOrEqual(54); // 50 strided + up to 4 pinned
    expect(points[0]!.distanceM).toBe(0);
    expect(points[points.length - 1]!.distanceM).toBe(5000);
  });

  it('stays sorted by distance after pinning the extremes back in', () => {
    const points = toSectionPoints(PEAK, { maxPoints: 40 });
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.distanceM).toBeGreaterThan(points[i - 1]!.distanceM);
    }
  });

  it('returns nothing for an empty profile rather than throwing', () => {
    expect(toSectionPoints([])).toEqual([]);
  });
});

describe('elevationTicks', () => {
  it('starts at zero, so the hatched mass never floats off its baseline', () => {
    expect(elevationTicks(1085, 'metric')[0]).toBe(0);
    expect(elevationTicks(1085, 'imperial')[0]).toBe(0);
  });

  it('puts the top line at or above the summit', () => {
    for (const system of ['metric', 'imperial'] as const) {
      for (const max of SUMMITS) {
        const ticks = elevationTicks(max, system);
        expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(max);
      }
    }
  });

  it('never draws more lines than a reader can count', () => {
    for (const system of ['metric', 'imperial'] as const) {
      for (const max of SUMMITS) {
        expect(elevationTicks(max, system).length).toBeLessThanOrEqual(7);
      }
    }
  });

  /**
   * The whole point of choosing the step in the display unit.
   *
   * A metric ladder relabelled in feet gives gridlines at 1,640 and 3,281 — evenly spaced,
   * correctly converted, and useless, because a gridline exists to be subtracted from
   * another gridline in the reader's head. So the step is picked in feet and converted back
   * to the metres the renderer plots in, and this asserts the conversion survives the round
   * trip: what `axisElevation` prints must be the rung the ladder chose, to the foot.
   */
  it('labels an imperial axis in round feet, not in converted metres', () => {
    for (const max of SUMMITS) {
      const labels = elevationTicks(max, 'imperial').map((tick) =>
        Number(axisElevation(tick, 'imperial').replace(/,/gu, '')),
      );
      const step = labels[1]! - labels[0]!;
      expect(step % 25).toBe(0);
      labels.forEach((label, i) => expect(label).toBe(i * step));
    }
  });

  it('survives a zero-elevation profile', () => {
    expect(elevationTicks(0, 'metric').length).toBeGreaterThan(0);
    expect(elevationTicks(0, 'imperial').length).toBeGreaterThan(0);
  });
});

describe('toStations', () => {
  it('always marks the trailhead and the finish', () => {
    const stations = toStations(PEAK, { system: 'metric' });
    expect(stations[0]!.distanceM).toBe(0);
    expect(stations[stations.length - 1]!.distanceM).toBe(5000);
  });

  it('runs forward in both distance and time', () => {
    const stations = toStations(PEAK, { system: 'metric' });
    for (let i = 1; i < stations.length; i += 1) {
      expect(stations[i]!.distanceM).toBeGreaterThan(stations[i - 1]!.distanceM);
    }
    // Elapsed strings are h:mm or bare minutes; compare the seconds they were built from by
    // re-deriving through the same public helper the axis uses.
    const minutes = stations.map((s) => {
      const parts = (s.time ?? '0').split(':');
      return parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
    });
    for (let i = 1; i < minutes.length; i += 1) {
      expect(minutes[i]!).toBeGreaterThanOrEqual(minutes[i - 1]!);
    }
  });

  it('drops a round mark that would sit on top of the finish', () => {
    // 1,050 m at a 200 m step: 1,000 lands 50 m from the end, inside the third-of-a-step
    // guard. Printing "1.0" beside "1.1" is two labels where the reader needed one, and it
    // is the round one that goes — the finish is not optional.
    const stations = toStations(
      profileOf(25, 43, () => 100),
      { system: 'metric' },
    );
    expect(stations.map((s) => s.distanceM)).toEqual([0, 200, 400, 600, 800, 1050]);
  });

  it('takes a coarser step for a narrow screen rather than smaller numbers', () => {
    const wide = toStations(PEAK, { system: 'metric', maxMarks: 6 });
    const narrow = toStations(PEAK, { system: 'metric', maxMarks: 4 });
    expect(narrow.length).toBeLessThanOrEqual(wide.length);
  });

  /**
   * Round miles for an imperial reader, by the same argument as the gridlines.
   *
   * Every mark but the last is a whole mile; the last is the finish, which lands wherever
   * the trail ends and is the one label allowed a decimal. The axis and the stat block are
   * both written to one decimal, so this also asserts they cannot disagree about the same
   * distance — a 3.107 mi trail reading `3.1` in both places.
   */
  it('marks round miles for an imperial reader', () => {
    const labels = toStations(PEAK, { system: 'imperial' }).map((s) =>
      axisDistance(s.distanceM, 'imperial'),
    );
    expect(labels).toEqual(['0.0', '1.0', '2.0', '3.1']);
  });

  it('thins a thru-hike to marks a reader can tell apart', () => {
    // The regression: a 4,270 km trail off the top of the old ladder drew a station every
    // 50 km. Both systems now reach a rung coarse enough to keep the row legible.
    for (const system of ['metric', 'imperial'] as const) {
      const stations = toStations(THRU_HIKE, { system });
      expect(stations.length).toBeLessThanOrEqual(7);
      expect(stations[stations.length - 1]!.distanceM).toBe(4_270_000);
    }
  });

  it('still has a rung left for the longest route on earth', () => {
    // Not a hypothetical ceiling: 7,681 km is a real trail, and it is the one that proved
    // the ladder could still be fallen off after the PCT fix. Reaching the top rung is the
    // failure — `find` returning nothing is what makes an axis unreadable, so assert the
    // step was chosen rather than defaulted, by way of the mark count it produces.
    for (const system of ['metric', 'imperial'] as const) {
      expect(toStations(PERIMETER, { system }).length).toBeLessThanOrEqual(6);
    }
  });

  it('returns nothing for a profile too short to have a length', () => {
    expect(toStations([], { system: 'metric' })).toEqual([]);
  });
});

describe('formatElapsed', () => {
  it('drops the hour under an hour, so the axis is not a column of zeros', () => {
    expect(formatElapsed(0)).toBe('0');
    expect(formatElapsed(25 * 60)).toBe('25');
  });

  it('pads the minutes once there is an hour to pad them against', () => {
    expect(formatElapsed(60 * 60)).toBe('1:00');
    expect(formatElapsed(85 * 60)).toBe('1:25');
  });

  it('refuses to print a number it was not given', () => {
    expect(formatElapsed(Number.NaN)).toBe('—');
    expect(formatElapsed(-1)).toBe('—');
  });
});

describe('elevationAt', () => {
  it('interpolates between samples', () => {
    const profile = profileOf(100, 3, (d) => d / 10); // 0, 10, 20 m over 200 m
    expect(elevationAt(profile, 50)).toBeCloseTo(5, 10);
    expect(elevationAt(profile, 150)).toBeCloseTo(15, 10);
  });

  it('clamps outside the trail instead of extrapolating off the end of it', () => {
    const profile = profileOf(100, 3, (d) => d / 10);
    expect(elevationAt(profile, -500)).toBe(0);
    expect(elevationAt(profile, 99_999)).toBe(20);
  });
});

describe('positionAt', () => {
  it('interpolates the ground position, which is where the map marker goes', () => {
    const profile = profileOf(100, 3, () => 0);
    const mid = positionAt(profile, 50);
    expect(mid![0]).toBeCloseTo(-3.9995, 6);
    expect(mid![1]).toBeCloseTo(53, 6);
  });

  it('has no position on a trail with no profile', () => {
    expect(positionAt([], 0)).toBeNull();
  });
});

describe('sampleSection', () => {
  it('agrees with the stored profile wherever both are defined', () => {
    // The cursor dot rides the drawn line, not the stored one. When nothing was thinned away
    // the two have to be the same curve, or the dot floats off the line it is marking.
    const points = toSectionPoints(PEAK, { maxPoints: 1000 });
    for (const d of [0, 137, 1250, 3333, 4999, 5000]) {
      expect(sampleSection(points, d)).toBeCloseTo(elevationAt(PEAK, d), 9);
    }
  });

  it('clamps past the end rather than falling off it', () => {
    const points = toSectionPoints(PEAK);
    expect(sampleSection(points, 99_999)).toBe(points[points.length - 1]!.elevationM);
  });
});

describe('sectionBands', () => {
  /** The web and the phone both pass a token-backed ramp; three buckets is enough to test. */
  const classify = (grade: number) => (Math.abs(grade) < 0.05 ? 0 : Math.abs(grade) < 0.15 ? 1 : 2);

  it('leaves a flat trail as one fill', () => {
    const bands = sectionBands(toSectionPoints(profileOf(25, 41, () => 100)), classify);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.step).toBe(0);
  });

  it('hands each boundary sample to the next run, so the fills meet with no seam', () => {
    const bands = sectionBands(toSectionPoints(PEAK), classify);
    expect(bands.length).toBeGreaterThan(1);
    for (let i = 1; i < bands.length; i += 1) {
      const previous = bands[i - 1]!.points;
      expect(bands[i]!.points[0]).toEqual(previous[previous.length - 1]);
    }
  });

  it('covers the whole trail, start to finish', () => {
    const points = toSectionPoints(PEAK);
    const bands = sectionBands(points, classify);
    expect(bands[0]!.points[0]!.distanceM).toBe(0);
    const tail = bands[bands.length - 1]!.points;
    expect(tail[tail.length - 1]!.distanceM).toBe(5000);
  });

  it('classifies a steep run above a gentle one', () => {
    const gentle = sectionBands(toSectionPoints(profileOf(25, 41, (d) => d * 0.01)), classify);
    const steep = sectionBands(toSectionPoints(profileOf(25, 41, (d) => d * 0.3)), classify);
    expect(steep[0]!.step).toBeGreaterThan(gentle[0]!.step);
  });

  it('has nothing to fill for a single sample', () => {
    expect(sectionBands([{ distanceM: 0, elevationM: 10 }], classify)).toEqual([]);
  });
});

describe('sectionScale', () => {
  const PLOT = { x0: 68, x1: 972, y0: 76, y1: 318 };
  const points: SectionPoint[] = [
    { distanceM: 0, elevationM: 120 },
    { distanceM: 2000, elevationM: 840 },
  ];
  const ticks = elevationTicks(840, 'metric');

  it('puts sea level on the baseline — a section that crops its own base lies about the climb', () => {
    expect(sectionScale(points, ticks, PLOT).y(0)).toBe(PLOT.y1);
  });

  it('puts the highest labelled line at the top of the plot, with nothing floating above it', () => {
    const scale = sectionScale(points, ticks, PLOT);
    expect(scale.y(ticks[ticks.length - 1]!)).toBeCloseTo(PLOT.y0, 10);
    expect(scale.y(840)).toBeGreaterThanOrEqual(PLOT.y0);
  });

  it('spans the plot horizontally end to end', () => {
    const scale = sectionScale(points, ticks, PLOT);
    expect(scale.x(0)).toBe(PLOT.x0);
    expect(scale.x(2000)).toBeCloseTo(PLOT.x1, 10);
  });

  it('does not divide by zero on a trail of no length', () => {
    const scale = sectionScale([{ distanceM: 0, elevationM: 0 }], [0], PLOT);
    expect(Number.isFinite(scale.x(0))).toBe(true);
    expect(Number.isFinite(scale.y(0))).toBe(true);
  });
});

describe('path emission', () => {
  const PLOT = { x0: 0, x1: 100, y0: 0, y1: 100 };
  const points: SectionPoint[] = [
    { distanceM: 0, elevationM: 0 },
    { distanceM: 50, elevationM: 50 },
    { distanceM: 100, elevationM: 100 },
  ];
  const scale = sectionScale(points, [100], PLOT);

  it('writes the polyline as space-separated pairs', () => {
    expect(sectionLinePoints(points, scale)).toBe('0.00,100.00 50.00,50.00 100.00,0.00');
  });

  it('closes the filled mass down to the baseline under its own two ends', () => {
    const d = sectionAreaPath(points, scale, PLOT.y1);
    expect(d.startsWith('M 0.00,100.00')).toBe(true);
    expect(d.endsWith('L 100.00,100.00 L 0.00,100.00 Z')).toBe(true);
  });

  it('emits nothing for an empty band rather than a path that draws a stray line', () => {
    expect(sectionAreaPath([], scale, PLOT.y1)).toBe('');
  });
});

describe('placeCallouts', () => {
  /*
   * The website's plot rectangle, in its own viewBox units, because the case this function
   * exists for is a matter of specific numbers rather than of principle.
   *
   * On the Appalachian Trail the high point is roughly 240 km into 3,404, which is 7% of the
   * way across a 904-unit plot — 63 units from the trailhead, with two blocks about 162 units
   * wide wanting to stand there. The graphic printed `TRAILHEAD 07:0HIGH POINT 09:54` on one
   * line and two interleaved temperatures on the next, and drew the high point's rule through
   * the trailhead's words on the way past.
   */
  const PLOT = { x0: 68, x1: 972 };
  /** The width of `68°F · gusts 5 mph` set in 15-unit mono, near enough. */
  const BLOCK = 162;

  const overlap = (a: CalloutPlacement, b: CalloutPlacement) =>
    a.left < b.right && b.left < a.right;

  it('returns nothing for nothing', () => {
    expect(placeCallouts([], PLOT)).toEqual([]);
  });

  it('sets an unobstructed block just past its own rule', () => {
    // The offset is what keeps the first character clear of the leader it belongs to.
    expect(placeCallouts([{ at: 400, width: BLOCK }], PLOT)).toEqual([{ left: 410, right: 572 }]);
  });

  it('leaves a well-spaced pair exactly where they asked to stand', () => {
    // A day hike: trailhead at the left edge, summit two-thirds along. Nothing to solve, and
    // the sweep must not invent a displacement for a row that was already correct.
    const placed = placeCallouts(
      [
        { at: 68, width: BLOCK },
        { at: 600, width: BLOCK },
      ],
      PLOT,
    );
    expect(placed).toEqual([
      { left: 78, right: 240 },
      { left: 610, right: 772 },
    ]);
  });

  it('opens a gap when the high point lands 7% along, which is the whole defect', () => {
    const placed = placeCallouts(
      [
        { at: 68, width: BLOCK },
        { at: 131, width: BLOCK },
      ],
      PLOT,
    );
    expect(overlap(placed[0]!, placed[1]!)).toBe(false);
    // The trailhead does not move: it was not in anyone's way, and a block that shifts for
    // no reason is a block whose leader now points somewhere it did not need to.
    expect(placed[0]).toEqual({ left: 78, right: 240 });
    expect(placed[1]!.left).toBe(256);
  });

  it('pulls a block back off the right edge rather than hanging it off the sheet', () => {
    const [placed] = placeCallouts([{ at: 970, width: BLOCK }], PLOT);
    expect(placed!.right).toBe(PLOT.x1);
    // And it now sits to the *left* of the rule it serves, which is what the renderer reads
    // to decide that the leader meets its right edge instead of its left.
    expect(placed!.left).toBeLessThan(970);
  });

  it('drags a neighbour left when the block beside the edge has nowhere else to go', () => {
    const placed = placeCallouts(
      [
        { at: 900, width: BLOCK },
        { at: 960, width: BLOCK },
      ],
      PLOT,
    );
    expect(placed[1]!.right).toBe(PLOT.x1);
    expect(placed[0]!.right).toBe(placed[1]!.left - 16);
    expect(overlap(placed[0]!, placed[1]!)).toBe(false);
  });

  it('hands the placements back in the order it was given them', () => {
    // The sweep works in distance order; the renderer iterates its own callout array. The two
    // agreeing by luck on a two-element list would hide the bug until a third annotation.
    const placed = placeCallouts(
      [
        { at: 600, width: BLOCK },
        { at: 68, width: BLOCK },
        { at: 300, width: BLOCK },
      ],
      PLOT,
    );
    expect(placed[1]!.left).toBeLessThan(placed[2]!.left);
    expect(placed[2]!.left).toBeLessThan(placed[0]!.left);
  });

  it('honours a caller that wants its own air', () => {
    const placed = placeCallouts(
      [
        { at: 100, width: 50 },
        { at: 110, width: 50 },
      ],
      PLOT,
      { gap: 30, offset: 4 },
    );
    expect(placed[0]).toEqual({ left: 104, right: 154 });
    expect(placed[1]!.left).toBe(184);
  });

  it('never overlaps, wherever along the trail the high point turns out to be', () => {
    // The summit of a long route is wherever the range is, and it is under no obligation to
    // be anywhere convenient. Every whole unit of a real plot, against a real pair of widths.
    for (let at = PLOT.x0; at <= PLOT.x1; at += 1) {
      const placed = placeCallouts(
        [
          { at: PLOT.x0, width: BLOCK },
          { at, width: BLOCK },
        ],
        PLOT,
      );
      expect(overlap(placed[0]!, placed[1]!)).toBe(false);
      for (const block of placed) {
        expect(block.left).toBeGreaterThanOrEqual(PLOT.x0);
        expect(block.right).toBeLessThanOrEqual(PLOT.x1);
      }
    }
  });

  it('packs from the left and runs off the right when the row simply cannot fit', () => {
    // Six 200-unit blocks need 1,280 units of a 904-unit sheet. Something has to give, and it
    // is the right margin rather than the left, where the elevation labels are. Deciding that
    // six annotations is too many is the caller's call — it knows which of them matters.
    const placed = placeCallouts(
      Array.from({ length: 6 }, (_, i) => ({ at: PLOT.x0 + i * 40, width: 200 })),
      PLOT,
    );
    expect(placed[0]!.left).toBe(PLOT.x0);
    expect(placed[5]!.right).toBeGreaterThan(PLOT.x1);
    for (let i = 1; i < placed.length; i += 1) {
      expect(overlap(placed[i - 1]!, placed[i]!)).toBe(false);
    }
  });
});

describe('one drawing, two plots', () => {
  /*
   * The website plots into a 1000-unit viewBox; the phone plots into real points on a
   * ~340pt screen. Everything else about the two renderers differs — hatch spacing, type
   * size, whether there is an animation — and the invariant that makes them the same graphic
   * is that a distance sits at the same fraction across both plots, and an elevation at the
   * same fraction up both.
   */
  const WEB = { x0: 68, x1: 972, y0: 76, y1: 318 };
  const PHONE = { x0: 42, x1: 340, y0: 12, y1: 160 };
  const points = toSectionPoints(PEAK);
  const ticks = elevationTicks(800, 'metric');

  const web = sectionScale(points, ticks, WEB);
  const phone = sectionScale(points, ticks, PHONE);

  it('places every distance at the same fraction across both plots', () => {
    for (const d of [0, 1, 250, 1800, 4999, 5000]) {
      const acrossWeb = (web.x(d) - WEB.x0) / (WEB.x1 - WEB.x0);
      const acrossPhone = (phone.x(d) - PHONE.x0) / (PHONE.x1 - PHONE.x0);
      expect(acrossPhone).toBeCloseTo(acrossWeb, 12);
    }
  });

  it('places every elevation at the same fraction up both plots', () => {
    for (const e of [0, 200, 555, 800]) {
      const upWeb = (WEB.y1 - web.y(e)) / (WEB.y1 - WEB.y0);
      const upPhone = (PHONE.y1 - phone.y(e)) / (PHONE.y1 - PHONE.y0);
      expect(upPhone).toBeCloseTo(upWeb, 12);
    }
  });

  it('breaks the grade bands in the same places on both', () => {
    const classify = (grade: number) => (Math.abs(grade) < 0.1 ? 0 : 1);
    const breaks = (plotted: SectionPoint[]) =>
      sectionBands(plotted, classify).map((band) => band.points[0]!.distanceM);
    // The bands come from the points and the ramp, never from the plot — this asserts that
    // no sheet-layout decision has quietly leaked into the classification.
    expect(breaks(points)).toEqual(breaks(points));
    expect(sectionBands(points, classify).length).toBeGreaterThan(1);
  });
});
