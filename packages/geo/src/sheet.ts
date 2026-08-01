import type { BBox, LngLat } from '@switchback/core';
import { MERCATOR_WORLD_PX, groundResolution, mercatorFraction, mercatorLngLat } from './tiles';

/**
 * Printed map sheets: geometry driven from the stated scale ratio rather than a zoom level, so
 * the ratio in the collar is a fact about the paper. Renderer- and DOM-free arithmetic.
 */

/** Millimetres per CSS pixel. CSS defines the inch as exactly 96 px, honoured when printing. */
export const MM_PER_CSS_PX = 25.4 / 96;

export interface SheetSizeMm {
  widthMm: number;
  heightMm: number;
}

export type SheetOrientation = 'portrait' | 'landscape';

export type PaperId = 'a4' | 'letter';

export interface SheetPaper {
  id: PaperId;
  label: string;
  /** The short edge, millimetres. Orientation decides which axis it lands on. */
  shortMm: number;
  longMm: number;
}

/** A4 and Letter cover essentially every printer a hiker reaches; larger formats are a plotter. */
export const SHEET_PAPERS: readonly SheetPaper[] = [
  { id: 'a4', label: 'A4', shortMm: 210, longMm: 297 },
  { id: 'letter', label: 'Letter', shortMm: 215.9, longMm: 279.4 },
] as const;

export function paperSizeMm(paper: PaperId, orientation: SheetOrientation): SheetSizeMm {
  const spec = SHEET_PAPERS.find((p) => p.id === paper) ?? SHEET_PAPERS[0]!;
  return orientation === 'landscape'
    ? { widthMm: spec.longMm, heightMm: spec.shortMm }
    : { widthMm: spec.shortMm, heightMm: spec.longMm };
}

/**
 * The scales offered, largest first in ground terms. Taken from what printed series use rather
 * than generated: a hiker who owns paper maps reads 1:25 000 without recalibrating.
 */
export const SHEET_SCALES: readonly number[] = [
  5_000, 10_000, 15_000, 25_000, 40_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000,
] as const;

/** What a sheet defaults to when nothing else decides — the ratio most hikers own. */
export const SHEET_DEFAULT_SCALE = 25_000;

/** How close to the neatline `fitSheetScale` will let a route come. */
export const SHEET_FIT_MARGIN_MM = 5;

export interface SheetFrame {
  /** The point at the middle of the map face. */
  centre: LngLat;
  /** The `n` in 1:n. */
  denominator: number;
  /** The map face itself — the neatline's inside, not the paper. */
  face: SheetSizeMm;
}

/** Metres of ground under one CSS pixel when a sheet at this ratio is printed. */
export function sheetMetresPerPx(denominator: number): number {
  return (denominator * MM_PER_CSS_PX) / 1_000;
}

/**
 * The renderer zoom that makes a printed millimetre mean what the ratio says. Fractional by
 * construction — rounding to an integer zoom would put the printed ratio out by up to 40%.
 */
export function sheetZoom(denominator: number, latDeg: number): number {
  const mPerPx = sheetMetresPerPx(denominator);
  if (!(mPerPx > 0)) return 0;
  return Math.log2(groundResolution(0, latDeg) / mPerPx);
}

/** The inverse: what ratio a rendered zoom amounts to on paper. */
export function sheetScaleDenominator(zoom: number, latDeg: number): number {
  return (groundResolution(zoom, latDeg) * 1_000) / MM_PER_CSS_PX;
}

/**
 * The whole Mercator world printed at this ratio, millimetres. Placing the graticule and the
 * route from this one number keeps them from drifting apart via a zoom round-trip.
 */
export function sheetWorldMm(denominator: number, latDeg: number): number {
  if (!(denominator > 0)) return 0;
  return (groundResolution(0, latDeg) * MERCATOR_WORLD_PX * 1_000) / denominator;
}

/**
 * Where a coordinate lands on the face, millimetres from its top-left corner. Points outside
 * the face are returned rather than clipped: clamping would draw a line along the neatline.
 */
export function sheetPointMm(point: LngLat, frame: SheetFrame): [number, number] {
  const world = sheetWorldMm(frame.denominator, frame.centre[1]);
  const [cx, cy] = mercatorFraction(frame.centre[0], frame.centre[1]);
  const [px, py] = mercatorFraction(point[0], point[1]);

  // Round the short way. Without this a sheet centred at 179°E puts a point at 179°W most of
  // a world's width off the page instead of forty kilometres to the right of centre.
  let dx = px - cx;
  if (dx > 0.5) dx -= 1;
  else if (dx < -0.5) dx += 1;

  return [frame.face.widthMm / 2 + dx * world, frame.face.heightMm / 2 + (py - cy) * world];
}

/** The inverse of `sheetPointMm` — what is under a point on the paper. */
export function sheetLngLat(xMm: number, yMm: number, frame: SheetFrame): LngLat {
  const world = sheetWorldMm(frame.denominator, frame.centre[1]);
  if (!(world > 0)) return frame.centre;
  const [cx, cy] = mercatorFraction(frame.centre[0], frame.centre[1]);
  return mercatorLngLat(
    cx + (xMm - frame.face.widthMm / 2) / world,
    cy + (yMm - frame.face.heightMm / 2) / world,
  );
}

/** The ground the face covers, as [west, south, east, north]. */
export function sheetBBox(frame: SheetFrame): BBox {
  const [west, north] = sheetLngLat(0, 0, frame);
  const [east, south] = sheetLngLat(frame.face.widthMm, frame.face.heightMm, frame);
  return [west, south, east, north];
}

/**
 * How much ground the face spans, metres — true at the sheet's centre latitude, the same caveat
 * the printed ratio carries. Quoted in the collar so a reader can size a sheet up at a glance.
 */
export function sheetCoverageM(frame: SheetFrame): { widthM: number; heightM: number } {
  return {
    widthM: (frame.face.widthMm * frame.denominator) / 1_000,
    heightM: (frame.face.heightMm * frame.denominator) / 1_000,
  };
}

/** Whether everything in `bbox` is inside the sheet's face. */
export function sheetFits(frame: SheetFrame, bbox: BBox): boolean {
  const [west, south, east, north] = sheetBBox(frame);
  return bbox[0] >= west && bbox[1] >= south && bbox[2] <= east && bbox[3] <= north;
}

/**
 * The middle of a bounding box, projected rather than averaged: Mercator spaces latitudes
 * unevenly, so a box from 45° to 55° has its paper midpoint at about 50.1°, not 50°.
 */
export function sheetCentre(bbox: BBox): LngLat {
  const [west, south, east, north] = bbox;
  const [, top] = mercatorFraction(0, north);
  const [, bottom] = mercatorFraction(0, south);
  return mercatorLngLat(((west + east) / 2 + 180) / 360, (top + bottom) / 2);
}

export interface FitSheetOptions {
  /** Ratios to choose between. Defaults to `SHEET_SCALES`. */
  scales?: readonly number[];
  /** Clear space kept between the route and the neatline. */
  marginMm?: number;
}

/**
 * The largest-scale sheet from the ladder that still holds the whole route. The ladder is the
 * point: a sheet marked 1:25 000 can be measured with a 1:25 000 romer, one marked 1:27 400
 * cannot. Falls through to the coarsest ratio when nothing fits; the caller checks `sheetFits`.
 */
export function fitSheetScale(
  bbox: BBox,
  face: SheetSizeMm,
  options: FitSheetOptions = {},
): number {
  const ladder = [...(options.scales?.length ? options.scales : SHEET_SCALES)].sort(
    (a, b) => a - b,
  );
  const marginMm = options.marginMm ?? SHEET_FIT_MARGIN_MM;
  const centre = sheetCentre(bbox);
  const usable: SheetSizeMm = {
    widthMm: Math.max(1, face.widthMm - 2 * marginMm),
    heightMm: Math.max(1, face.heightMm - 2 * marginMm),
  };

  for (const denominator of ladder) {
    if (sheetFits({ centre, denominator, face: usable }, bbox)) return denominator;
  }
  return ladder[ladder.length - 1] ?? SHEET_DEFAULT_SCALE;
}

export interface SheetBarScale {
  /** Ground distance the bar spans, metres. */
  groundM: number;
  /** How long the bar is on paper, millimetres. */
  lengthMm: number;
  /** Divisions along it, drawn alternately filled and open. */
  rungs: number;
}

/**
 * A bar scale no longer than `maxMm`, spanning a round 1-2-5 number of metres — the only
 * rounding an eye can subdivide. Drawn as well as stated because a bar survives photocopying.
 */
export function sheetBarScale(denominator: number, maxMm: number): SheetBarScale {
  if (!(denominator > 0) || !(maxMm > 0)) return { groundM: 0, lengthMm: 0, rungs: 0 };

  const maxGroundM = (maxMm * denominator) / 1_000;
  const decade = 10 ** Math.floor(Math.log10(maxGroundM));
  const mantissa = maxGroundM / decade;
  const step = mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1;
  const groundM = step * decade;

  return {
    groundM,
    lengthMm: (groundM * 1_000) / denominator,
    // Five rungs off a 5 divides into whole decades; four off a 1 or a 2 gives quarters.
    rungs: step === 5 ? 5 : 4,
  };
}

/** One graticule line, already placed on the face. */
export interface SheetGraticuleLine {
  /** Longitude for a meridian, latitude for a parallel. */
  deg: number;
  /** Millimetres from the left edge of the face for a meridian, from the top for a parallel. */
  mm: number;
  label: string;
}

export interface SheetGraticule {
  /** Spacing chosen from the ladder, degrees. */
  intervalDeg: number;
  meridians: SheetGraticuleLine[];
  parallels: SheetGraticuleLine[];
}

const SECOND_DEG = 1 / 3_600;
const MINUTE_DEG = 1 / 60;

/**
 * Graticule spacings, sexagesimal because the labels are — a reader converting a grid reference
 * works in degrees, minutes and seconds. Every rung divides its neighbour, so stepping the sheet
 * in or out subdivides the lines already drawn rather than replacing them.
 */
const GRATICULE_STEPS_DEG: readonly number[] = [
  15 * SECOND_DEG,
  30 * SECOND_DEG,
  MINUTE_DEG,
  2 * MINUTE_DEG,
  5 * MINUTE_DEG,
  10 * MINUTE_DEG,
  15 * MINUTE_DEG,
  30 * MINUTE_DEG,
  1,
  2,
  5,
] as const;

/**
 * Divisions across the sheet the interval aims for. Four is deliberately few: a graticule is a
 * reference frame, and every line past what that needs is ink over the ground being shown.
 */
const GRATICULE_DIVISIONS = 4;

/** No sheet has this many lines on it; the cap is a guard against a degenerate interval. */
const GRATICULE_MAX_LINES = 400;

/**
 * The graticule for a sheet. Computed from the frame, not read back from a renderer: the
 * sheet's camera is pinned to `sheetZoom` and north-up, so the overlay cannot disagree with the
 * map under it. One interval for both axes, sized off the wider span — ruling them differently
 * gives a grid of rectangles that reads as a projection artefact.
 */
export function sheetGraticule(frame: SheetFrame): SheetGraticule {
  const [west, south, east, north] = sheetBBox(frame);
  const spanLng = east - west;
  const spanLat = north - south;
  const wanted = Math.max(spanLng, spanLat) / GRATICULE_DIVISIONS;
  const sized =
    GRATICULE_STEPS_DEG.find((step) => step >= wanted) ??
    GRATICULE_STEPS_DEG[GRATICULE_STEPS_DEG.length - 1] ??
    1;

  /*
   * Step back down until the *shorter* axis carries a line as well. An interval sized off the
   * wider axis is routinely wider than the shorter axis is tall — at 1:40 000 the ladder picks
   * 5′ for a sheet 3′14″ high, printing meridians and no parallels. GRATICULE_DIVISIONS is a
   * target, not a contract.
   */
  const shorter = Math.min(spanLng, spanLat);
  const fitted = GRATICULE_STEPS_DEG.filter((step) => step <= shorter).pop();
  const intervalDeg = sized <= shorter ? sized : (fitted ?? GRATICULE_STEPS_DEG[0] ?? sized);

  // Whole seconds, so the loop below accumulates integers rather than adding a fraction like
  // 1/240 repeatedly and drifting off the labels it prints.
  const stepSec = Math.max(1, Math.round(intervalDeg * 3_600));

  const meridians: SheetGraticuleLine[] = [];
  for (
    let sec = Math.ceil((west * 3_600) / stepSec) * stepSec;
    sec <= east * 3_600 && meridians.length < GRATICULE_MAX_LINES;
    sec += stepSec
  ) {
    const deg = sec / 3_600;
    const [mm] = sheetPointMm([deg, frame.centre[1]], frame);
    meridians.push({ deg, mm, label: formatDegrees(deg, 'lng') });
  }

  const parallels: SheetGraticuleLine[] = [];
  for (
    let sec = Math.ceil((south * 3_600) / stepSec) * stepSec;
    sec <= north * 3_600 && parallels.length < GRATICULE_MAX_LINES;
    sec += stepSec
  ) {
    const deg = sec / 3_600;
    const [, mm] = sheetPointMm([frame.centre[0], deg], frame);
    parallels.push({ deg, mm, label: formatDegrees(deg, 'lat') });
  }

  return { intervalDeg, meridians, parallels };
}

export type SheetAxis = 'lat' | 'lng';

/**
 * A coordinate in degrees, minutes and seconds with the hemisphere as a letter. Trailing zero
 * components are dropped (`50°N`, not `50°00′00″N`) and signs are never printed.
 */
export function formatDegrees(deg: number, axis: SheetAxis): string {
  const south = axis === 'lat' && deg < 0;
  const west = axis === 'lng' && deg < 0;
  const hemisphere = axis === 'lat' ? (south ? 'S' : 'N') : west ? 'W' : 'E';

  const total = Math.round(Math.abs(deg) * 3_600);
  const degrees = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');

  if (seconds === 0 && minutes === 0) return `${degrees}°${hemisphere}`;
  if (seconds === 0) return `${degrees}°${pad(minutes)}′${hemisphere}`;
  return `${degrees}°${pad(minutes)}′${pad(seconds)}″${hemisphere}`;
}

/**
 * The ratio as a collar writes it: `1:25 000`. A thin space is the cartographic convention and
 * sidesteps half the world reading `25,000` as twenty-five; grouped by hand, never by locale.
 */
export function formatScale(denominator: number): string {
  return `1:${String(Math.round(denominator)).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ')}`;
}
