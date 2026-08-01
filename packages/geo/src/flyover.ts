import type { ElevationPoint, LngLat } from '@switchback/core';
import { bearingDeg } from './distance';
import { highPointIndex } from './profile';
import { elevationAt, positionAt } from './section';
import { EARTH_CIRCUMFERENCE_M, MERCATOR_WORLD_PX } from './tiles';
import { type PaceOptions, cumulativeTimeS } from './tobler';

/**
 * Camera poses for a route flyover, renderer-agnostic. Progress is linear in modelled hiking
 * time (Tobler), not distance, so the flyover and the elevation section share one integral.
 */

/** Screen milliseconds per modelled hour on the hill — a four-hour hike becomes a 48 s film. */
export const FLYOVER_MS_PER_HIKING_HOUR = 12_000;

/**
 * Floor and ceiling on the running time. The ceiling is load-bearing: unclamped, the Pacific
 * Crest Trail's ~3,000 modelled hours would run for ten hours of film.
 */
export const FLYOVER_MIN_MS = 15_000;
export const FLYOVER_MAX_MS = 75_000;

/**
 * The heading is measured across a window of tread, not toward a look-ahead point: the
 * displacement from the mean of its first half to the mean of its second, so switchback legs
 * cancel instead of whipping the camera. Width is set in seconds of film (the eye's tolerance
 * is degrees per second) with a metre floor, because Tobler slows the camera on exactly the
 * steep ground where the window would otherwise shrink back inside a switchback stack.
 */
export const FLYOVER_HEADING_S = 2;
export const FLYOVER_HEADING_MIN_M = 400;

/**
 * Samples per window half. A fixed count, not a fixed spacing, so per-frame cost is flat from a
 * 400 m window to a 112 km one and the mean stays a continuous function of progress.
 */
const HEADING_SAMPLES = 32;

/**
 * Ground crossing time for one screen width. Fixing screen speed rather than zoom keeps a
 * 2 km stroll and a 4,000 km thru-hike equally watchable under the clamped duration.
 */
export const FLYOVER_SECONDS_PER_SCREEN = 3.5;

/**
 * Bounds on the camera height. The floor is where a global DEM stops describing terrain and
 * starts describing its own sampling; the ceiling is its ~90 m spacing.
 */
export const FLYOVER_MIN_ZOOM = 10.5;
export const FLYOVER_MAX_ZOOM = 15.5;

/**
 * Camera tilt off vertical, degrees — steep enough to keep the horizon in frame.
 * Above MapLibre's default `maxPitch` of 60, so a map using this has to raise it.
 */
export const FLYOVER_PITCH = 66;

/**
 * The camera must also clear the ground it flies over, at this fraction of the route's relief;
 * the screen-speed rule alone puts an alpine flyover inside the relief and returns a green wash.
 * The floor covers routes with no relief, and is below what the speed rule asks for on any of them.
 */
export const FLYOVER_RELIEF_CLEARANCE = 0.55;
export const FLYOVER_MIN_CLEARANCE_M = 250;

/**
 * Web Mercator ground resolution at zoom 0, m/px at the equator. Derived, not typed: the literal
 * 78_271.516_964 is one keystroke from the 156_543 of the 256-px convention, a silent level out.
 */
const EQUATOR_M_PER_PX = EARTH_CIRCUMFERENCE_M / MERCATOR_WORLD_PX;

/**
 * Camera-to-target distance in screen heights. MapLibre puts it at `0.5 · height / tan(fov/2)`,
 * which its default 36.87° field of view makes exactly 1.5 — a renderer changing `fov` breaks this.
 */
const CAMERA_DISTANCE_SCREENS = 1.5;

export interface FlyoverViewport {
  /** Map width in CSS pixels. Sets how fast the ground crosses the screen. */
  width: number;
  /** Map height in CSS pixels. Sets how high the camera is at a given zoom. */
  height: number;
}

export interface FlyoverZoomOptions {
  /**
   * The renderer's terrain exaggeration, if it has one. Relief is measured from the profile
   * in real metres, but the mesh the camera has to clear is drawn at this multiple of it.
   */
  exaggeration?: number;
}

/**
 * The zoom to fly the route at. Two rules — cross a screen width in
 * `FLYOVER_SECONDS_PER_SCREEN`, and stay `FLYOVER_RELIEF_CLEARANCE` of the relief above the
 * path — and whichever wants more ground in frame wins. Latitude is taken from mid-route.
 */
export function flyoverZoom(
  plan: FlyoverPlan,
  viewport: FlyoverViewport,
  options: FlyoverZoomOptions = {},
): number {
  const seconds = plan.durationMs / 1000;
  const { width, height } = viewport;
  if (!(seconds > 0) || !(width > 0) || !(height > 0)) return FLYOVER_MIN_ZOOM;

  const groundSpeedMps = plan.lengthM / seconds;
  const speedMPerPx = groundSpeedMps / (width / FLYOVER_SECONDS_PER_SCREEN);

  // Camera height above target is the camera-to-centre distance foreshortened by the tilt.
  const relief = reliefM(plan.profile) * (options.exaggeration ?? 1);
  const clearanceM = Math.max(FLYOVER_MIN_CLEARANCE_M, relief * FLYOVER_RELIEF_CLEARANCE);
  const clearanceMPerPx =
    clearanceM / (CAMERA_DISTANCE_SCREENS * height * Math.cos((FLYOVER_PITCH * Math.PI) / 180));

  const wantedMPerPx = Math.max(speedMPerPx, clearanceMPerPx);
  if (!(wantedMPerPx > 0)) return FLYOVER_MAX_ZOOM;

  const middle = plan.profile[Math.floor(plan.profile.length / 2)];
  const scale = EQUATOR_M_PER_PX * Math.cos(((middle?.lat ?? 0) * Math.PI) / 180);
  const zoom = Math.log2(scale / wantedMPerPx);

  return Math.min(FLYOVER_MAX_ZOOM, Math.max(FLYOVER_MIN_ZOOM, zoom));
}

/** Highest point minus lowest, metres — zero for a profile with nothing usable in it. */
function reliefM(profile: readonly ElevationPoint[]): number {
  let low = Infinity;
  let high = -Infinity;
  for (const point of profile) {
    if (point.eleM < low) low = point.eleM;
    if (point.eleM > high) high = point.eleM;
  }
  return Number.isFinite(low) && Number.isFinite(high) ? high - low : 0;
}

export interface FlyoverPose {
  /** The point on the route the camera is looking at. */
  center: LngLat;
  /** Compass heading the camera faces, degrees clockwise from north. */
  bearing: number;
  /**
   * How far along the route this pose is. The paired elevation section takes its cursor from
   * here, which is why it is on the pose rather than recomputed by the caller.
   */
  distanceM: number;
  /** Ground height at `center`, metres. */
  eleM: number;
}

export interface FlyoverPlan {
  readonly profile: readonly ElevationPoint[];
  /** Cumulative modelled seconds at each profile point — the pacing curve itself. */
  readonly cumTimeS: readonly number[];
  /** Modelled moving time for the whole route, seconds. */
  readonly hikingTimeS: number;
  readonly lengthM: number;
  /** How long the flyover runs on screen, after the floor and ceiling are applied. */
  readonly durationMs: number;
}

/**
 * Precompute everything the animation loop must not do per frame: the Tobler integral is O(n)
 * and a long trail has tens of thousands of points. Returns null for a route too short to fly.
 */
export function planFlyover(
  profile: readonly ElevationPoint[],
  opts: PaceOptions = {},
): FlyoverPlan | null {
  if (profile.length < 2) return null;

  const cumTimeS = cumulativeTimeS(profile, opts);
  const hikingTimeS = cumTimeS[cumTimeS.length - 1] ?? 0;
  const lengthM = profile[profile.length - 1]?.distM ?? 0;
  if (!(hikingTimeS > 0) || !(lengthM > 0)) return null;

  const wanted = (hikingTimeS / 3600) * FLYOVER_MS_PER_HIKING_HOUR;
  const durationMs = Math.min(FLYOVER_MAX_MS, Math.max(FLYOVER_MIN_MS, wanted));

  return { profile, cumTimeS, hikingTimeS, lengthM, durationMs };
}

/**
 * Distance reached after so many modelled seconds — the inverse of `timeAtDistanceS`. Exported
 * because it is the pacing itself: a pose-only test cannot tell Tobler pacing from constant speed.
 */
export function distanceAtTimeS(plan: FlyoverPlan, seconds: number): number {
  const { cumTimeS, profile } = plan;
  const last = profile.length - 1;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (seconds >= plan.hikingTimeS) return plan.lengthM;

  // Cumulative time is non-decreasing, so the containing segment is a binary search, not a scan.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cumTimeS[mid] ?? 0) <= seconds) lo = mid;
    else hi = mid;
  }

  const span = (cumTimeS[hi] ?? 0) - (cumTimeS[lo] ?? 0);
  const t = span === 0 ? 0 : (seconds - (cumTimeS[lo] ?? 0)) / span;
  const from = profile[lo]?.distM ?? 0;
  const to = profile[hi]?.distM ?? from;
  return from + (to - from) * t;
}

/**
 * The pose at `progress` (0 → 1). Pure: nothing is carried between frames, so smoothing lives in
 * the shape of the heading window and seeking to a frame gives the same heading as playing to it.
 */
export function poseAt(plan: FlyoverPlan, progress: number): FlyoverPose | null {
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const hikingS = clamped * plan.hikingTimeS;
  const distanceM = distanceAtTimeS(plan, hikingS);
  const center = positionAt(plan.profile, distanceM);
  if (!center) return null;

  // Full width, starting at the camera, sliding back off the end rather than narrowing against it.
  const windowM = Math.min(headingWindowM(plan, hikingS), plan.lengthM);
  const fromM = Math.max(0, Math.min(distanceM, plan.lengthM - windowM));
  const halfM = windowM / 2;
  const near = meanPosition(plan.profile, center, fromM, halfM);
  const far = meanPosition(plan.profile, center, fromM + halfM, halfM);

  // Both halves at one point means the stretch doubles back exactly and reports no direction.
  let bearing = 0;
  if (near && far && !samePoint(near, far)) bearing = bearingDeg(near, far);
  else if (far && !samePoint(center, far)) bearing = bearingDeg(center, far);

  return { center, bearing, distanceM, eleM: elevationAt(plan.profile, distanceM) };
}

/**
 * Tread the heading is measured across: the ground `FLYOVER_HEADING_S` of film cross, or the
 * floor. The span is anchored to its end, not to the camera, so near the finish it slides back
 * at full width instead of decaying to zero and reading single OSM segments.
 */
function headingWindowM(plan: FlyoverPlan, hikingS: number): number {
  const screenS = plan.durationMs / 1_000;
  const hikingPerScreenS = screenS > 0 ? plan.hikingTimeS / screenS : 0;
  const spanS = Math.min(FLYOVER_HEADING_S * hikingPerScreenS, plan.hikingTimeS);
  const endS = Math.min(hikingS + spanS, plan.hikingTimeS);
  const crossed = distanceAtTimeS(plan, endS) - distanceAtTimeS(plan, endS - spanS);
  return Math.max(crossed, FLYOVER_HEADING_MIN_M);
}

/**
 * Mean position of `windowM` of tread from `fromM`. Sampled at strip midpoints so the mean is
 * unbiased — edge sampling leans both halves the same way and tilts hairpins. Longitudes are
 * averaged as ±180-wrapped offsets from `origin`, or a route astride the antimeridian averages
 * +180 and −180 to somewhere near Africa.
 */
function meanPosition(
  profile: readonly ElevationPoint[],
  origin: LngLat,
  fromM: number,
  windowM: number,
): LngLat | null {
  if (!(windowM > 0)) return null;

  let lng = 0;
  let lat = 0;
  let n = 0;
  for (let k = 0; k < HEADING_SAMPLES; k += 1) {
    const at = positionAt(profile, fromM + ((k + 0.5) / HEADING_SAMPLES) * windowM);
    if (!at) continue;
    lng += ((at[0] - origin[0] + 540) % 360) - 180;
    lat += at[1];
    n += 1;
  }
  return n === 0 ? null : [origin[0] + lng / n, lat / n];
}

/**
 * A single still for `prefers-reduced-motion`, where the pitched sweep must not run at all:
 * high point centred, faced from mid-route rather than the trailhead, which on routes starting
 * in trees below the summit would aim at a hillside hiding it.
 */
export function flyoverOverview(plan: FlyoverPlan): FlyoverPose | null {
  const summit = plan.profile[highPointIndex(plan.profile)];
  if (!summit) return null;
  const center: LngLat = [summit.lng, summit.lat];

  const middle = positionAt(plan.profile, plan.lengthM / 2);
  const start = positionAt(plan.profile, 0);
  const vantage = middle && !samePoint(middle, center) ? middle : start;

  return {
    center,
    bearing: vantage && !samePoint(vantage, center) ? bearingDeg(vantage, center) : 0,
    distanceM: summit.distM,
    eleM: summit.eleM,
  };
}

/** Within ~1 m of latitude — closer than anything feeding this, so a bearing between them is noise. */
function samePoint(a: LngLat, b: LngLat): boolean {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}
