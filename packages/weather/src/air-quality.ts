/**
 * Air quality over an area, drawn at the resolution the model actually has.
 *
 * The temptation with a scalar field over a map is to interpolate it into a smooth wash.
 * That is a lie with a colour ramp on it: the CAMS global model publishes one number per
 * 40 km square, and a gradient between two of those squares invents a hundred readings
 * nobody computed. So the overlay is a lattice of hard-edged cells at the model's own
 * spacing, and the key says what that spacing is. A reader who can see the cells knows
 * exactly how much to trust a boundary — the same argument the slope layer makes for
 * `raster-resampling: nearest`.
 *
 * **Two models, two resolutions.** Open-Meteo serves CAMS Europe over its regional domain
 * at 0.1° and CAMS global everywhere else at 0.4°. Both are surfaced through one endpoint
 * and it does not say which answered, so the domain test happens here. Getting this wrong
 * in the optimistic direction would draw a 0.1° lattice over ground that has one value per
 * 0.4° — sixteen identical cells pretending to be sixteen readings.
 *
 * **Coarsening is honest, refining is not.** A wide viewport gets fewer, bigger cells so the
 * upstream call stays one request; a narrow one never gets cells smaller than the model.
 * The grid says which happened, and the key tells the reader.
 */

import type { AirQualityCell, AirQualityGrid, AirQualityReading, BBox } from '@switchback/core';
import { AIR_QUALITY_POLLUTANTS, type AirQualityPollutant } from '@switchback/core';
import type { AirQualityNow, GeoPoint } from './open-meteo';
import { OpenMeteoClient } from './open-meteo';
import { HOUR_S } from './time';

/**
 * The CAMS European regional domain, as CAMS publishes it: 25°W–45°E, 30°N–72°N.
 *
 * Used only when a viewport sits *wholly* inside it. A box straddling the edge would
 * otherwise get a 0.1° lattice over the half of it the global model answered, which is the
 * exact overclaim this test exists to prevent.
 */
export const CAMS_EUROPE_DOMAIN: BBox = [-25, 30, 45, 72];

export const AQI_MODEL_EUROPE_DEG = 0.1;
export const AQI_MODEL_GLOBAL_DEG = 0.4;

export const AQI_MODEL_EUROPE = 'CAMS Europe';
export const AQI_MODEL_GLOBAL = 'CAMS global';

/**
 * How many cells one upstream call may carry.
 *
 * Sixty-four is eight by eight, which is about the aspect of a map pane, and it keeps the
 * query string near a kilobyte. The number is a budget rather than a target: a viewport
 * over one valley in Europe asks for far fewer, because the lattice never gets finer than
 * the model no matter how much room is left.
 */
export const AQI_GRID_MAX_CELLS = 64;

/**
 * The coarsest lattice worth drawing, in degrees.
 *
 * At 1.6° a cell is about 175 km across, which is still a real statement about a weather
 * system. Past that the overlay becomes six colours over a continent — technically the
 * same data, but no longer an answer to any question a hiker has. Beyond this the grid
 * comes back empty and the key says to zoom in, exactly as the slope key does below its
 * own floor.
 */
export const AQI_MAX_STEP_DEG = 1.6;

export interface AirQualityDeps {
  client?: OpenMeteoClient;
  /** Epoch milliseconds. Injected in tests. */
  now?: () => number;
}

export interface GridModel {
  label: string;
  /** The model's native grid spacing, in degrees. */
  resolutionDeg: number;
}

/** Which model answers for this box, and how finely. */
export function modelFor(bbox: BBox): GridModel {
  const [w, s, e, n] = bbox;
  const [dw, ds, de, dn] = CAMS_EUROPE_DOMAIN;
  const inside = w >= dw && e <= de && s >= ds && n <= dn;
  return inside
    ? { label: AQI_MODEL_EUROPE, resolutionDeg: AQI_MODEL_EUROPE_DEG }
    : { label: AQI_MODEL_GLOBAL, resolutionDeg: AQI_MODEL_GLOBAL_DEG };
}

export interface GridPlan {
  model: GridModel;
  /** Lattice spacing actually used — the model resolution, or a doubling of it. */
  stepDeg: number;
  /** True when the viewport forced a coarser lattice than the model can support. */
  coarsened: boolean;
  cells: readonly PlannedCell[];
}

export interface PlannedCell {
  /** Cell centre. Longitudes may run outside ±180 when the viewport crossed the seam. */
  lng: number;
  lat: number;
  bbox: BBox;
}

/**
 * Lay a lattice over the viewport.
 *
 * Cell *centres* sit on multiples of the step and footprints extend half a step either
 * side, which is how Open-Meteo's own grid is laid out — ask it about 53.07 and it answers
 * for 53.1. Building the lattice the same way means a cell we draw is a cell it computed,
 * rather than a box straddling two of them.
 *
 * Doubling, not arbitrary division, is what keeps the lattice stable under panning: every
 * step in the ladder is a whole number of model cells, anchored at zero, so the same ground
 * lands in the same cell however the reader arrived at it — and the cache key stays hot.
 */
export function planGrid(bbox: BBox, maxCells = AQI_GRID_MAX_CELLS): GridPlan {
  const model = modelFor(bbox);
  const [w, s, e, n] = normalise(bbox);

  let stepDeg = model.resolutionDeg;
  while (stepDeg <= AQI_MAX_STEP_DEG && count(w, e, stepDeg) * count(s, n, stepDeg) > maxCells) {
    stepDeg *= 2;
  }

  if (stepDeg > AQI_MAX_STEP_DEG) {
    return { model, stepDeg, coarsened: true, cells: [] };
  }

  const cells: PlannedCell[] = [];
  for (const lat of centres(s, n, stepDeg)) {
    for (const lng of centres(w, e, stepDeg)) {
      const half = stepDeg / 2;
      cells.push({
        lng,
        lat,
        bbox: [round(lng - half), round(lat - half), round(lng + half), round(lat + half)],
      });
    }
  }

  return { model, stepDeg, coarsened: stepDeg > model.resolutionDeg, cells };
}

/**
 * The grid, fetched.
 *
 * Cells whose reading came back null are kept rather than dropped. A hole in the lattice
 * and a cell the model had no answer for look identical once painted, and the second one
 * is a fact worth being able to see.
 */
export async function airQualityGrid(
  bbox: BBox,
  deps: AirQualityDeps = {},
): Promise<AirQualityGrid> {
  const plan = planGrid(bbox);
  const nowMs = deps.now?.() ?? Date.now();
  const observedAt = new Date(Math.floor(nowMs / 1000 / HOUR_S) * HOUR_S * 1000).toISOString();

  if (plan.cells.length === 0) {
    return {
      cells: [],
      model: plan.model.label,
      stepDeg: plan.stepDeg,
      observedAt,
      coarsened: plan.coarsened,
    };
  }

  const client = deps.client ?? new OpenMeteoClient();
  // Wrapped back into ±180 for the request only. The footprint keeps the un-wrapped
  // longitude so a cell east of the antimeridian draws beside its neighbour rather than
  // jumping the width of the world.
  const asked: GeoPoint[] = plan.cells.map((cell) => ({ lat: cell.lat, lng: wrapLng(cell.lng) }));
  const readings = await client.airQualityNow(asked);

  const cells: AirQualityCell[] = plan.cells.map((cell, index) => ({
    lng: cell.lng,
    lat: cell.lat,
    bbox: cell.bbox,
    europeanAqi: readings[index]?.europeanAqi ?? null,
  }));

  return {
    cells,
    model: plan.model.label,
    stepDeg: plan.stepDeg,
    observedAt: stampOf(readings, observedAt),
    coarsened: plan.coarsened,
  };
}

/**
 * One reading, with the pollutant behind it named.
 *
 * Snapped to the model lattice before the call, which is what makes this cacheable: every
 * trail in the same 0.1° cell breathes the same air, so they should share one upstream
 * request rather than each spending their own on the same number.
 */
export async function airQualityAt(
  lng: number,
  lat: number,
  deps: AirQualityDeps = {},
): Promise<AirQualityReading> {
  const model = modelFor([lng, lat, lng, lat]);
  const snapped = {
    lng: snap(wrapLng(lng), model.resolutionDeg),
    lat: snap(lat, model.resolutionDeg),
  };

  const client = deps.client ?? new OpenMeteoClient();
  const [reading] = await client.airQualityNow([snapped]);
  const nowMs = deps.now?.() ?? Date.now();

  if (!reading) {
    return {
      lng: snapped.lng,
      lat: snapped.lat,
      europeanAqi: null,
      pm25: null,
      dominant: null,
      model: model.label,
      stepDeg: model.resolutionDeg,
      observedAt: new Date(Math.floor(nowMs / 1000 / HOUR_S) * HOUR_S * 1000).toISOString(),
    };
  }

  return {
    lng: reading.lng,
    lat: reading.lat,
    europeanAqi: reading.europeanAqi,
    pm25: reading.pm25,
    dominant: dominantPollutant(reading),
    model: model.label,
    stepDeg: model.resolutionDeg,
    observedAt: new Date((reading.timeS || Math.floor(nowMs / 1000)) * 1000).toISOString(),
  };
}

/**
 * Which pollutant the index is worst on.
 *
 * The European AQI is the maximum of its five sub-indices, so the one that equals it is by
 * construction the one driving the number. Named only when it actually matches, within a
 * point of rounding — if the sub-indices and the headline disagree by more than that,
 * something upstream is inconsistent and the honest answer is to say nothing rather than
 * to blame the largest of five numbers that do not add up.
 */
export function dominantPollutant(reading: AirQualityNow): AirQualityPollutant | null {
  const indices: Record<AirQualityPollutant, number | null> = {
    pm2_5: reading.pm25Index,
    pm10: reading.pm10Index,
    no2: reading.no2Index,
    o3: reading.ozoneIndex,
    so2: reading.so2Index,
  };

  let best: AirQualityPollutant | null = null;
  let bestValue = -Infinity;
  for (const pollutant of AIR_QUALITY_POLLUTANTS) {
    const value = indices[pollutant];
    if (value === null) continue;
    if (value > bestValue) {
      bestValue = value;
      best = pollutant;
    }
  }

  if (best === null) return null;
  if (reading.europeanAqi === null) return best;
  return Math.abs(bestValue - reading.europeanAqi) <= 1 ? best : null;
}

/**
 * The cache key for a viewport.
 *
 * Built from the *lattice*, not the bbox: two viewports covering the same cells are the
 * same question however the reader's pan happened to end, and keying on raw coordinates
 * would make every pixel of drag a cache miss for an identical answer. The hour is in
 * there because these are hourly model fields — the same reason the forecast cache buckets
 * by hour.
 */
export function airQualityGridKey(bbox: BBox, nowMs: number): string {
  const plan = planGrid(bbox);
  const first = plan.cells[0];
  const last = plan.cells[plan.cells.length - 1];
  const span = first && last ? `${first.lng},${first.lat},${last.lng},${last.lat}` : 'empty';
  return `grid|${plan.stepDeg}|${span}|${Math.floor(nowMs / 1000 / HOUR_S)}`;
}

/** The same, for a single point. Every trail in one model cell shares an entry. */
export function airQualityPointKey(lng: number, lat: number, nowMs: number): string {
  const step = modelFor([lng, lat, lng, lat]).resolutionDeg;
  return `at|${snap(wrapLng(lng), step)},${snap(lat, step)}|${Math.floor(nowMs / 1000 / HOUR_S)}`;
}

/**
 * The hour the readings are actually for, preferred over our own clock.
 *
 * Upstream publishes on its own schedule and can be an hour behind wall time; stamping
 * these with `Date.now()` would date a reading to an hour it was never computed for.
 */
function stampOf(readings: readonly AirQualityNow[], fallback: string): string {
  const timeS = readings.find((reading) => reading.timeS > 0)?.timeS;
  return timeS === undefined ? fallback : new Date(timeS * 1000).toISOString();
}

/** Cell centres of a lattice with the given step, covering `[min, max]` inclusive. */
function centres(min: number, max: number, step: number): number[] {
  const first = Math.floor((min + step / 2) / step);
  const last = Math.floor((max + step / 2) / step);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(round(i * step));
  return out;
}

function count(min: number, max: number, step: number): number {
  return Math.floor((max + step / 2) / step) - Math.floor((min + step / 2) / step) + 1;
}

/**
 * A viewport, made sane.
 *
 * MapLibre reports bounds in the frame the user panned into, so longitudes run past ±180
 * after crossing the seam and a world-spanning view can report a range wider than 360.
 * Latitudes are clamped because Web Mercator's poles are at ±85 but `getBounds` will
 * happily report ±90 on a zoomed-out map, and asking a weather model about 89.6°N over a
 * viewport that shows no such ground wastes cells on the grid budget.
 */
function normalise(bbox: BBox): BBox {
  const [w, s, e, n] = bbox;
  const west = e - w >= 360 ? -180 : w;
  const east = e - w >= 360 ? 180 : e;
  return [west, Math.max(-85, s), east, Math.min(85, n)];
}

function wrapLng(lng: number): number {
  return round(((((lng + 180) % 360) + 360) % 360) - 180);
}

function snap(value: number, step: number): number {
  return round(Math.round(value / step) * step);
}

/** Four decimals is ~11 m — well inside any of these grids, and it kills binary drift. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
