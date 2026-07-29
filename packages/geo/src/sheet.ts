import type { BBox, LngLat } from '@switchback/core';
import { MERCATOR_WORLD_PX, groundResolution, mercatorFraction, mercatorLngLat } from './tiles';

/**
 * A map sheet: paper, a stated scale, and the geometry that follows from the two.
 *
 * Everything else in this product measures a map in zoom levels, which is a screen unit —
 * it says how much ground a *pixel* covers, and a pixel has no size until someone chooses a
 * display. Paper is the one place that stops being true. A printed sheet has a real width
 * in millimetres, so the scale is a fact about the artefact rather than a setting, and it is
 * the fact the whole sheet is read by: a hiker measuring a bearing off a printed map with
 * the edge of a compass is trusting the ratio in the collar, and if it is decorative the map
 * is worse than no map.
 *
 * So the sheet is driven from the ratio, not from the zoom. The reader picks 1:25 000, and
 * the camera zoom, the graticule interval, the bar scale and the ground the sheet covers all
 * fall out of it. `sheetZoom` is the one place the two worlds meet, and it is exact: CSS
 * defines an inch as 96 pixels, browsers honour physical units when printing, so a sheet
 * laid out in millimetres at the zoom this returns measures what the collar claims.
 *
 * **The honest caveat, which the collar has to print.** Mercator is conformal, not
 * equal-area: it stretches ground by 1/cos φ, so a stated ratio is exact at one latitude
 * only. On a sheet covering a few kilometres the error across the face is a fraction of a
 * per cent — well under the width of the pencil line anyone would draw on it — but the sheet
 * still says which latitude it is exact at, because a map that quietly rounds is a map you
 * cannot tell has stopped being accurate.
 *
 * Nothing here touches a renderer or a DOM. It is arithmetic on paper sizes and coordinates,
 * so the printed sheet can be tested without a printer.
 */

/**
 * Millimetres per CSS pixel.
 *
 * CSS defines the inch as exactly 96 pixels, and print stylesheets are honoured in physical
 * units — this is the constant that makes a browser a usable cartographic output device
 * rather than an approximate one.
 */
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

/**
 * The two papers worth supporting.
 *
 * A4 and US Letter between them cover essentially every printer a hiker has access to, and
 * they are close enough in size that a sheet laid out for one is legible on the other. Larger
 * formats are a plotter question, and a plotter owner can scale a PDF.
 */
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
 * The scales offered, largest first in ground terms — 1:5 000 shows the most detail.
 *
 * Taken from what printed series actually use rather than generated as round numbers, because
 * a hiker who owns paper maps has calibrated eyes: 1:25 000 and 1:50 000 are the two most
 * hikers in the world have handled, and a sheet at one of them is read without recalibrating.
 * The coarse end exists for long-distance paths, where the honest output is a strip overview
 * rather than something to navigate a single day by.
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
 * The renderer zoom that makes a printed millimetre mean what the ratio says.
 *
 * The whole bridge between "1:25 000" and a map library, in one line: find the ground
 * resolution the paper demands, then ask what zoom produces it at this latitude. Fractional
 * by construction — a scale that happened to land on an integer zoom would be a coincidence,
 * and rounding to one would put the printed ratio out by up to 40%.
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
 * How wide the entire Mercator world would be, printed at this ratio, in millimetres.
 *
 * An absurd number — hundreds of metres of paper — and the most useful one here. Every
 * position on the sheet is a fraction of the world times this, so working in world
 * millimetres turns projection into a single multiplication and keeps the sheet's geometry
 * free of any zoom round-trip. The graticule and the route are placed by the same arithmetic,
 * which is why they cannot drift apart.
 */
export function sheetWorldMm(denominator: number, latDeg: number): number {
  if (!(denominator > 0)) return 0;
  return (groundResolution(0, latDeg) * MERCATOR_WORLD_PX * 1_000) / denominator;
}

/**
 * Where a coordinate lands on the face, millimetres from its top-left corner.
 *
 * Returns points outside the face rather than clipping them — a route that runs off the sheet
 * is a fact the caller has to be able to see, and silently clamping it to the edge would draw
 * a line along the neatline that looks like part of the trail.
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
 * How much ground the face spans, metres.
 *
 * True at the sheet's centre latitude, which is the same caveat the printed ratio carries and
 * for the same reason. Quoted in the collar so a reader can size up a sheet before reading a
 * single line on it: "4.8 km across" says more at a glance than "1:25 000" does.
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
 * The middle of a bounding box, projected rather than averaged.
 *
 * The arithmetic mean of two latitudes is not the middle of the sheet those latitudes appear
 * on — Mercator spaces them unevenly, so a box spanning 45° to 55° has its paper midpoint at
 * about 50.1°. Small, and exactly the kind of small error that puts a route a few millimetres
 * off-centre and makes a fitted sheet clip at one edge while leaving white space at the other.
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
 * The largest-scale sheet that still holds the whole route.
 *
 * Ascending through the ladder and taking the first fit, rather than computing a ratio and
 * rounding to the nearest rung: the ladder is the point. A sheet marked 1:25 000 can be
 * measured with a 1:25 000 romer, and one marked 1:27 400 — which is what a continuous fit
 * would produce — can be measured with nothing at all.
 *
 * Falls through to the coarsest ratio offered when nothing fits, which happens on a route
 * like the Pacific Crest Trail where the honest answer is that it does not go on a page. The
 * caller checks `sheetFits` and says so.
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
 * A bar scale no longer than `maxMm`, spanning a round number of metres.
 *
 * Round in the 1-2-5 sense, which is the only sense that matters on a scale bar: the reader
 * is going to divide it by eye, and thirds of 3 km is not something an eye does. The bar is
 * also the part of the collar that survives photocopying — a stated ratio is wrong the moment
 * the sheet is resized, and a drawn bar is still right — which is why it is drawn at all when
 * the ratio is already printed beside it.
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
    // Five rungs off a 5 divides into whole decades; four off a 1 or a 2 gives quarters and
    // halves. Both are numbers a reader can halve again in their head at the roadside.
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
 * Graticule spacings, in the units a coordinate is actually quoted in.
 *
 * Sexagesimal rather than decimal, because the labels are: a reader converting a grid
 * reference off this sheet works in degrees, minutes and seconds, and a graticule ruled every
 * 0.02° gives them nothing to count. Every rung divides its neighbour, so zooming a sheet in
 * or out one step subdivides the lines already drawn rather than replacing them.
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
 * How many divisions across the sheet the interval aims for.
 *
 * Four, which is few. A graticule is a reference frame, not a texture — its job is to let a
 * reader pin a feature to a coordinate, and every extra line past what that needs is ink laid
 * over the ground the sheet exists to show. Printed series are similarly sparse for exactly
 * this reason; the density people remember from a topographic map is the contours.
 */
const GRATICULE_DIVISIONS = 4;

/** No sheet has this many lines on it; the cap is a guard against a degenerate interval. */
const GRATICULE_MAX_LINES = 400;

/**
 * The graticule for a sheet — where the lines fall on the paper, and what to label them.
 *
 * Computed from the frame rather than read back from a renderer, which is what makes it
 * trustworthy: the sheet's camera is pinned to `sheetZoom` and north-up, so the position of
 * every meridian is fully determined by arithmetic, and a graticule drawn as an overlay
 * cannot disagree with the map under it the way one queried from a moving camera can.
 *
 * One interval for both axes, sized off the wider span. Ruling latitude and longitude at
 * different intervals would produce a grid of rectangles that reads as a projection artefact
 * rather than as a coordinate frame.
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
   * Then step back down until the *shorter* axis carries a line as well.
   *
   * A landscape face spans getting on for twice as much longitude as latitude — 260 mm by
   * 150 mm, and a degree of longitude at 51°N is only 63% of a degree of latitude — so an
   * interval sized off the wider axis is routinely wider than the shorter axis is tall. At
   * 1:40 000 the ladder picks 5′ for a sheet 3′14″ high, and what prints is meridians and no
   * parallels: half a coordinate frame, and the half that cannot be read off the collar.
   *
   * Dropping a rung costs the wide axis a couple of extra lines and buys the short one the
   * line it has to have. `GRATICULE_DIVISIONS` is a target, not a contract, and this is the
   * one case where the target is the wrong thing to hold.
   */
  const shorter = Math.min(spanLng, spanLat);
  const fitted = GRATICULE_STEPS_DEG.filter((step) => step <= shorter).pop();
  const intervalDeg = sized <= shorter ? sized : (fitted ?? GRATICULE_STEPS_DEG[0] ?? sized);

  // Whole seconds, so the loop below accumulates integers rather than repeatedly adding a
  // fraction like 1/240 and drifting off the labels it prints.
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
 * A coordinate in degrees, minutes and seconds, with the hemisphere as a letter.
 *
 * Trailing zero components are dropped — `50°N`, not `50°00′00″N` — because a graticule label
 * is read in passing, and the zeros are three characters of nothing between the reader and
 * the number that changes. Signs are never printed: a hiker reads N/S/E/W, and a minus in
 * front of a latitude is a database's way of saying south.
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
 * The ratio written the way a collar writes it: `1:25 000`, thin spaces and all.
 *
 * A thin space rather than a comma, which is the cartographic convention and also sidesteps
 * the fact that half the world reads `25,000` as twenty-five. Grouped by hand rather than by
 * locale: a printed sheet's ratio is not a number the reader's regional settings get an
 * opinion about.
 */
export function formatScale(denominator: number): string {
  return `1:${String(Math.round(denominator)).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ')}`;
}
