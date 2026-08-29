import {
  METRES_PER_FOOT as M_PER_FT,
  METRES_PER_MILE as M_PER_MI,
  type ElevationPoint,
  type UnitSystem,
} from '@switchback/core';
import { cumulativeTimeS, timeAtDistanceS, type PaceOptions } from './tobler';

/**
 * The section: an elevation profile projected onto a drawing, down to the SVG path `d`, so the
 * web and React Native renderers plot one graphic rather than two that resemble each other.
 * Lives here rather than in `@switchback/ui` because it needs `cumulativeTimeS`, which the
 * deliberately dependency-free tokens package cannot import. Everything in this file is pure.
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
 * Samples the section is drawn from by default. Not a cost limit — the hatching is: each change
 * of grade band opens a new path, and at the stored 25 m spacing DEM noise flips the band into
 * static. This puts the effective grade window at 50–100 m, the same one `maxSustainedGrade` uses.
 */
export const SECTION_DISPLAY_POINTS = 220;

/**
 * Elevation gridline steps, in the reader's own unit of height. First one yielding ≤5 lines wins.
 *
 * Two ladders rather than one converted ladder: a round number of metres is not a round number of
 * feet, and relabelling a 500 m rung gives gridlines at 1,640 ft and 3,281 ft. The step is chosen
 * in the unit it will be printed in, then converted back to metres for plotting.
 */
const TICK_STEPS = {
  metric: [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000],
  imperial: [25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000],
} as const satisfies Record<UnitSystem, readonly number[]>;

/**
 * Distance station steps, in the reader's own unit of length, aiming for 4–7 marks. One ladder for
 * both systems, since kilometres and miles are both decimal; only the conversion differs.
 *
 * Starts at 0.2, not 0.25: labels are written to one decimal to match the stat block, and
 * converted quarters print as `0.0 0.3 0.5 0.8 1.0`. Reaches 5,000 so no walkable route falls off
 * the top — the American Perimeter Trail is 7,681 km, and the fallback is a worse axis every time.
 */
const STATION_STEPS = [
  0.2, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000,
] as const;

/**
 * Which samples survive thinning: an even stride, plus the ends and the two extremes. A plain
 * every-Nth stride drops the summit whenever it is off the stride, and a section whose high
 * point is 40 m below the stat block above it is worse than no section.
 *
 * Indices rather than points, so anything computed alongside the profile — an ascent curve,
 * say — can be thinned through the same choice and stay paired with it.
 */
export function sectionSampleIndices(
  profile: readonly ElevationPoint[],
  maxPoints = SECTION_DISPLAY_POINTS,
): number[] {
  const cap = Math.max(2, maxPoints);
  if (profile.length <= cap) return profile.map((_, i) => i);

  let highest = 0;
  let lowest = 0;
  for (let i = 1; i < profile.length; i += 1) {
    if (profile[i]!.eleM > profile[highest]!.eleM) highest = i;
    if (profile[i]!.eleM < profile[lowest]!.eleM) lowest = i;
  }

  const stride = Math.ceil(profile.length / cap);
  const keep = new Set<number>([0, profile.length - 1, highest, lowest]);
  for (let i = 0; i < profile.length; i += stride) keep.add(i);
  return [...keep].sort((a, b) => a - b);
}

/** Thin the profile for drawing. */
export function toSectionPoints(
  profile: readonly ElevationPoint[],
  opts: { maxPoints?: number } = {},
): SectionPoint[] {
  return sectionSampleIndices(profile, opts.maxPoints ?? SECTION_DISPLAY_POINTS).map((i) => ({
    distanceM: profile[i]!.distM,
    elevationM: profile[i]!.eleM,
  }));
}

/**
 * Gridlines from the ground up, in the reader's units, returned in metres. Zero is always
 * included, and the top tick is the first at or above the summit.
 *
 * `system` is required rather than defaulted: a defaulted `'metric'` is exactly how this drew a
 * metric axis under an imperial stat block at every call site at once.
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
 * Distance marks along the bottom, each carrying elapsed moving time. Trailhead and finish are
 * always marked, and a round mark within a third of a step of either is dropped as redundant.
 * Returns metres, chosen on a ladder of round miles or kilometres — see {@link elevationTicks}.
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

/** Elapsed moving time as `h:mm`, or `mm` under an hour — sits in a row of axis labels. */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}` : `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Slide the collar annotations along until none overprints another. The block moves, the leader
 * does not: a callout drawn away from its distance would be a lie about the trail.
 *
 * Three passes, each needed because the one before can leave the row wrong: left to right opening
 * gaps; right to left pulling a row pushed past the right edge back inside; left to right again,
 * because pass 2 has no floor and would push a too-wide row off the left edge. Blocks return in
 * the order given. A row that genuinely cannot fit packs left and runs off the right margin;
 * culling needs to know which annotation matters, which this cannot.
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
 * `classify` is passed in because the grade ramp is a design token in `@switchback/ui`, which
 * this package does not depend on. Runs hand their boundary sample to the next, so fills meet
 * with no seam down the middle of a climb.
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
 * Map distance and elevation onto the plot rectangle. The vertical scale starts at zero, not at
 * the lowest sample: a section that crops its own base exaggerates the climb. Ticks are folded
 * in so the top of the scale is the highest labelled line.
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
