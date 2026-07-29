import {
  METRES_PER_FOOT as M_PER_FT,
  METRES_PER_MILE as M_PER_MI,
  type ElevationPoint,
  type UnitSystem,
} from '@switchback/core';
import { cumulativeTimeS, timeAtDistanceS, type PaceOptions } from './tobler';

/**
 * The section: an elevation profile projected onto a drawing.
 *
 * The section is the product's signature graphic and it is drawn twice — as SVG in the
 * browser and as `react-native-svg` on the phone. This module is why those two are one
 * graphic rather than two that resemble each other: every number either renderer plots
 * comes from here, down to the `d` attribute of the hatched mass.
 *
 * **Why it lives in `@switchback/geo` and not in `@switchback/ui`.** Nearly all of it is
 * the elevation profile in a different coordinate system — downsampling that keeps the
 * summit, an elapsed-time axis that has to agree with `cumulativeTimeS` to the second,
 * interpolation between 25 m samples. That maths belongs beside the maths it calls. The
 * tokens package is deliberately dependency-free and could not import `cumulativeTimeS`
 * without giving that up.
 *
 * **Why SVG strings.** A path `d` is a geometry serialisation that both renderers accept
 * verbatim, so producing it here is what stops the two from re-deriving the same curve
 * with subtly different rounding. Nothing about colour, type or layout is decided here;
 * the plot rectangle is passed in, because a 1000-unit-wide sheet and a phone screen want
 * different padding and different label sizes.
 *
 * Everything in this file is pure.
 */

/** One plotted sample. Distance along the trail, height above sea level. */
export interface SectionPoint {
  distanceM: number;
  elevationM: number;
}

export interface SectionStation {
  distanceM: number;
  /** Arrival clock or elapsed time, already resolved. Rendered under the distance. */
  time?: string;
}

/** A collar annotation, as the layout sees it: where it points, and how wide its text is. */
export interface CalloutBox {
  /** Where the leader meets the section, in the plot's own horizontal units. */
  at: number;
  /** The width of the block's widest line, measured by whoever knows the type. */
  width: number;
}

/** Where a block ended up. Both edges, because which one the leader meets depends. */
export interface CalloutPlacement {
  left: number;
  right: number;
}

/** A run of the profile sharing one grade band, ready to be filled at that band's density. */
export interface SectionBand {
  /** Index into whatever ramp the caller's `classify` returns against. */
  step: number;
  points: SectionPoint[];
}

/** The drawing rectangle, in the renderer's own units. */
export interface SectionPlot {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Distance and elevation, mapped onto the plot. */
export interface SectionScale {
  x: (distanceM: number) => number;
  y: (elevationM: number) => number;
  maxDistanceM: number;
  maxElevationM: number;
}

/**
 * How many samples the section is drawn from by default.
 *
 * The stored profile is sampled every 25 m, so a 20 km trail arrives as 800 points. Drawing
 * all of them is not the problem; the hatching is. Each change of grade band opens a new
 * path, and at 25 m spacing DEM noise flips the band constantly — a gentle valley path can
 * produce two hundred alternating fills that read as static rather than as terrain.
 * Downsampling to roughly this many points puts the effective grade window at 50–100 m,
 * which is the same window `maxSustainedGrade` uses and the same one a hiker feels.
 */
export const SECTION_DISPLAY_POINTS = 220;

/**
 * Elevation gridline steps, **in the reader's own unit of height**. First one that yields
 * ≤5 lines wins.
 *
 * Two ladders rather than one converted ladder, because a round number of metres is not a
 * round number of feet. Relabelling a 500 m rung in imperial gives gridlines at 1,640 ft and
 * 3,281 ft — evenly spaced, correctly converted, and useless, because the whole job of a
 * gridline is to be a number you can subtract from another number in your head. The step is
 * therefore chosen in the unit it will be *printed* in, and only then converted back to
 * metres for plotting; the geometry stays SI and the ladder stops being a translation.
 */
const TICK_STEPS = {
  metric: [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000],
  imperial: [25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000],
} as const satisfies Record<UnitSystem, readonly number[]>;

/**
 * Distance station steps, in the reader's own unit of length. Same rule, aiming for 4–7.
 *
 * One ladder for both systems: kilometres and miles are both decimal, so the rungs that are
 * round in one are round in the other. Only the conversion to metres differs.
 *
 * It starts at 0.2 rather than 0.25 because the labels are written to one decimal — that is
 * what keeps them in step with the stat block above, which rounds the same way. A quarter
 * rung cannot be written to one decimal, and the attempt is what printed the `0.0 0.3 0.5
 * 0.8 1.0 1.1` row on a 1.1 km trail: five *converted* quarters, none of them round, on an
 * axis whose entire purpose is round numbers. 0.2 is exact at that precision, and lands a
 * mark every 200 m on the short walks that need them most.
 *
 * The top of the ladder is 5,000 rather than 50 because thru-routes exist. The old ceiling
 * meant `find` returned nothing for anything past 300 km, the fallback took over at 50, and
 * the Pacific Crest Trail drew eighty-five stations into a band of overprinted digits.
 *
 * It reaches 5,000 rather than stopping at 1,000 because the Pacific Crest Trail is not the
 * long one. The American Perimeter Trail is 7,681 km, which divides by a 1,000 rung into
 * 7.7 — past `maxMarks`, so `find` missed it and the fallback took over again, one rung
 * lower than the row needed. Two more rungs cost nothing and put the ceiling beyond any
 * walkable route on earth; a ladder whose last rung is reachable is a ladder that will be
 * fallen off, and the fallback is a worse axis every time it is used.
 */
const STATION_STEPS = [
  0.2, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000,
] as const;

/**
 * Thin the profile for drawing, keeping the extremes.
 *
 * A plain every-Nth stride would drop the summit whenever the summit is not on the stride,
 * and a section whose high point is 40 m lower than the stat block above it is worse than
 * no section. The first, last, highest and lowest samples are pinned; the rest are strided.
 *
 * `maxPoints` is a parameter rather than a constant because a phone draws the same trail
 * into a third of the width — past a point the extra samples are sub-pixel detail that
 * still costs a path each.
 */
export function toSectionPoints(
  profile: readonly ElevationPoint[],
  opts: { maxPoints?: number } = {},
): SectionPoint[] {
  const maxPoints = Math.max(2, opts.maxPoints ?? SECTION_DISPLAY_POINTS);
  if (profile.length === 0) return [];
  if (profile.length <= maxPoints) {
    return profile.map((p) => ({ distanceM: p.distM, elevationM: p.eleM }));
  }

  let highest = 0;
  let lowest = 0;
  for (let i = 1; i < profile.length; i += 1) {
    if (profile[i]!.eleM > profile[highest]!.eleM) highest = i;
    if (profile[i]!.eleM < profile[lowest]!.eleM) lowest = i;
  }

  const stride = Math.ceil(profile.length / maxPoints);
  const keep = new Set<number>([0, profile.length - 1, highest, lowest]);
  for (let i = 0; i < profile.length; i += stride) keep.add(i);

  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => ({ distanceM: profile[i]!.distM, elevationM: profile[i]!.eleM }));
}

/**
 * Gridlines from the ground up, in the reader's units.
 *
 * Zero is always included because the section's vertical scale starts there — a baseline
 * with no line on it leaves the hatched mass floating. The top tick is the first one at or
 * above the summit, so the summit never sits above the highest labelled line.
 *
 * Returns **metres**, as everything in this package does, even though the ladder was chosen
 * in feet for an imperial reader. The values are exact rungs of that ladder converted once,
 * so `axisElevation` rounds each back to the whole number it came from — the renderer never
 * has to know which system picked the step.
 *
 * `system` is required rather than defaulted. A defaulted `'metric'` is precisely how this
 * drew a metric axis under an imperial stat block for as long as it did: every call site
 * took the default, and the default was invisible at all of them.
 */
export function elevationTicks(maxEleM: number, system: UnitSystem): number[] {
  const perUnitM = system === 'imperial' ? M_PER_FT : 1;
  const max = Math.max(maxEleM, 1) / perUnitM;
  const ladder = TICK_STEPS[system];
  const step = ladder.find((candidate) => max / candidate <= 5) ?? ladder[ladder.length - 1]!;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step; value += step) ticks.push(value * perUnitM);
  return ticks;
}

/**
 * Distance marks along the bottom, each carrying elapsed moving time.
 *
 * The trailhead and the finish are always marked, and a nice round mark that lands within
 * a third of a step of either is dropped — "18.0" and "18.4" sitting side by side is two
 * labels where the reader needed one, and it is always the round one that is redundant.
 *
 * `maxMarks` lowers the target count for a narrow screen. The step ladder is the same, so a
 * phone gets a coarser round number rather than the same numbers set smaller.
 *
 * Returns metres, chosen on a ladder of round miles or round kilometres — see
 * {@link elevationTicks} on why the choice is made in the display unit and why `system` is
 * not optional.
 */
export function toStations(
  profile: readonly ElevationPoint[],
  opts: PaceOptions & { system: UnitSystem; maxMarks?: number },
): SectionStation[] {
  if (profile.length < 2) return [];

  const maxMarks = opts.maxMarks ?? 6;
  const totalM = profile[profile.length - 1]!.distM;
  const cum = cumulativeTimeS(profile, opts);
  const at = (distM: number) => formatElapsed(timeAtDistanceS(profile, cum, distM));

  const perUnitM = opts.system === 'imperial' ? M_PER_MI : 1000;
  const total = totalM / perUnitM;
  const stepUnits =
    STATION_STEPS.find((candidate) => total / candidate <= maxMarks) ??
    STATION_STEPS[STATION_STEPS.length - 1]!;
  const step = stepUnits * perUnitM;
  const marks: number[] = [0];
  for (let value = step; value < totalM; value += step) {
    if (value > step / 3 && totalM - value > step / 3) marks.push(value);
  }
  marks.push(totalM);

  return marks.map((distanceM) => ({ distanceM, time: at(distanceM) }));
}

/**
 * Elapsed moving time as `h:mm`, or `mm` under an hour.
 *
 * Colon-separated rather than `1h 25m` because these sit in a row of axis labels under a
 * row of distances: same character width, same rhythm, no unit noise repeated six times.
 */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}` : `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Slide the collar annotations along until none of them overprints another.
 *
 * A callout points at a place on the trail, and where that place lands is the trail's
 * business, not the sheet's. On a day hike the two the section carries — the trailhead and
 * the high point — are half a plot apart and there is nothing to solve. On the Appalachian
 * Trail the high point is 240 km in, which is 7% of 3,404 km, so its block was drawn on top
 * of the trailhead's: `TRAILHEAD 07:0HIGH POINT 09:54` on one line and two temperatures
 * interleaved on the next. Not a rare case either — the summit of a long route is wherever
 * the range is, and it is under no obligation to be in the middle.
 *
 * The block moves; the leader does not. That is the whole trade. A callout drawn somewhere
 * other than its distance would be a lie about the trail, so the rule and the dot stay put
 * and the renderer draws an arm across to wherever the text ended up — which is what a
 * printed sheet does with a crowded margin, and why the annotation is a *leader* line.
 *
 * Three passes, and each one exists because the pass before it can leave the row wrong:
 *
 * 1. Left to right, opening a gap: nothing begins until the block in front of it has ended.
 * 2. Right to left, pulling the row back inside the sheet: a block pushed past the right
 *    edge by pass 1 drags its neighbours left with it rather than hanging off the paper.
 * 3. Left to right again, because pass 2 has no floor: a row wider than the sheet would
 *    otherwise be pushed off the *left* edge, into the elevation labels.
 *
 * Blocks come back in the order they were given, whatever order they were in. When the row
 * genuinely cannot fit — more callouts than the sheet has room for — it packs from the left
 * and runs off the right, where there is a margin. Culling is the caller's decision to make
 * and it needs to know which annotation matters, which this cannot.
 */
export function placeCallouts(
  boxes: readonly CalloutBox[],
  plot: { x0: number; x1: number },
  opts: { gap?: number; offset?: number } = {},
): CalloutPlacement[] {
  const n = boxes.length;
  if (n === 0) return [];

  const gap = opts.gap ?? 16;
  const offset = opts.offset ?? 10;

  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.at - boxes[b]!.at);
  const width = order.map((i) => boxes[i]!.width);
  const left = order.map((i) => boxes[i]!.at + offset);

  for (let i = 1; i < n; i += 1) {
    left[i] = Math.max(left[i]!, left[i - 1]! + width[i - 1]! + gap);
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    left[i] = Math.min(left[i]!, (i === n - 1 ? plot.x1 : left[i + 1]! - gap) - width[i]!);
  }
  for (let i = 0; i < n; i += 1) {
    left[i] = Math.max(left[i]!, i === 0 ? plot.x0 : left[i - 1]! + width[i - 1]! + gap);
  }

  const placed: CalloutPlacement[] = new Array<CalloutPlacement>(n);
  order.forEach((original, i) => {
    placed[original] = { left: left[i]!, right: left[i]! + width[i]! };
  });
  return placed;
}

/** Elevation at an arbitrary distance along the stored profile, interpolated. */
export function elevationAt(profile: readonly ElevationPoint[], distM: number): number {
  if (profile.length === 0) return 0;
  if (distM <= profile[0]!.distM) return profile[0]!.eleM;

  const last = profile.length - 1;
  if (distM >= profile[last]!.distM) return profile[last]!.eleM;

  const [lo, hi] = bracket(profile, distM);
  const span = profile[hi]!.distM - profile[lo]!.distM;
  const t = span === 0 ? 0 : (distM - profile[lo]!.distM) / span;
  return profile[lo]!.eleM + (profile[hi]!.eleM - profile[lo]!.eleM) * t;
}

/** The point on the ground at a given distance along the trail — where the map marker goes. */
export function positionAt(
  profile: readonly ElevationPoint[],
  distM: number,
): [number, number] | null {
  if (profile.length === 0) return null;
  const last = profile.length - 1;
  if (distM <= profile[0]!.distM) return [profile[0]!.lng, profile[0]!.lat];
  if (distM >= profile[last]!.distM) return [profile[last]!.lng, profile[last]!.lat];

  const [lo, hi] = bracket(profile, distM);
  const span = profile[hi]!.distM - profile[lo]!.distM;
  const t = span === 0 ? 0 : (distM - profile[lo]!.distM) / span;
  return [
    profile[lo]!.lng + (profile[hi]!.lng - profile[lo]!.lng) * t,
    profile[lo]!.lat + (profile[hi]!.lat - profile[lo]!.lat) * t,
  ];
}

/** Binary search for the pair of samples that bracket a distance. Callers clamp first. */
function bracket(profile: readonly ElevationPoint[], distM: number): [number, number] {
  let lo = 0;
  let hi = profile.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid]!.distM <= distM) lo = mid;
    else hi = mid;
  }
  return [lo, hi];
}

/** Elevation at an arbitrary distance along the *drawn* points — where the cursor dot sits. */
export function sampleSection(points: readonly SectionPoint[], distanceM: number): number {
  if (points.length === 0) return 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (distanceM <= b.distanceM) {
      const span = b.distanceM - a.distanceM;
      const t = span === 0 ? 0 : (distanceM - a.distanceM) / span;
      return a.elevationM + t * (b.elevationM - a.elevationM);
    }
  }
  return points[points.length - 1]!.elevationM;
}

/**
 * Split the profile into runs of one grade band so each can take its own hatch density.
 *
 * `classify` is passed in rather than imported: the grade ramp is a design token and lives
 * in `@switchback/ui`, which this package deliberately does not depend on. What is shared
 * here is the part that is easy to get subtly wrong — runs hand their boundary sample to
 * the next run, so adjacent fills meet with no seam down the middle of a climb.
 */
export function sectionBands(
  points: readonly SectionPoint[],
  classify: (grade: number) => number,
): SectionBand[] {
  const out: SectionBand[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const run = b.distanceM - a.distanceM;
    const step = classify(run === 0 ? 0 : (b.elevationM - a.elevationM) / run);
    const last = out[out.length - 1];
    if (last && last.step === step) last.points.push(b);
    else out.push({ step, points: [a, b] });
  }
  return out;
}

/**
 * Map distance and elevation onto the plot rectangle.
 *
 * The vertical scale starts at zero rather than at the lowest sample. A section that crops
 * its own base exaggerates the climb, which is the one lie a hiker cannot afford — the
 * ticks are folded in so the top of the scale is the highest labelled line, never a summit
 * floating above it.
 */
export function sectionScale(
  points: readonly SectionPoint[],
  ticks: readonly number[],
  plot: SectionPlot,
): SectionScale {
  const maxDistanceM = Math.max(1, ...points.map((p) => p.distanceM));
  const maxElevationM = Math.max(1, ...ticks, ...points.map((p) => p.elevationM));
  return {
    maxDistanceM,
    maxElevationM,
    x: (distanceM) => plot.x0 + (distanceM / maxDistanceM) * (plot.x1 - plot.x0),
    y: (elevationM) => plot.y1 - (elevationM / maxElevationM) * (plot.y1 - plot.y0),
  };
}

/** The profile line, as the `points` attribute of a polyline. */
export function sectionLinePoints(points: readonly SectionPoint[], scale: SectionScale): string {
  return points
    .map((p) => `${fixed(scale.x(p.distanceM))},${fixed(scale.y(p.elevationM))}`)
    .join(' ');
}

/** One band's filled mass, closed down to the baseline, as a path `d`. */
export function sectionAreaPath(
  points: readonly SectionPoint[],
  scale: SectionScale,
  baselineY: number,
): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return '';
  const top = points.map((p) => `${fixed(scale.x(p.distanceM))},${fixed(scale.y(p.elevationM))}`);
  return `M ${top.join(' L ')} L ${fixed(scale.x(last.distanceM))},${fixed(baselineY)} L ${fixed(
    scale.x(first.distanceM),
  )},${fixed(baselineY)} Z`;
}

function fixed(value: number): string {
  return value.toFixed(2);
}
