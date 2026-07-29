import type { ElevationPoint, LngLat } from '@switchback/core';
import { bearingDeg } from './distance';
import { highPointIndex } from './profile';
import { elevationAt, positionAt } from './section';
import { EARTH_CIRCUMFERENCE_M, MERCATOR_WORLD_PX } from './tiles';
import { type PaceOptions, cumulativeTimeS } from './tobler';

/**
 * The camera path for a route flyover.
 *
 * **Progress is linear in modelled hiking time, not in distance.** That single choice is
 * what separates this from a pan along a line. A flyover that advances at a constant metres
 * per second crosses a 30% headwall and a flat forest track at the same rate, which tells the
 * reader the two are equivalent — the exact opposite of what the elevation section beside it
 * says. Driving the parameter through Tobler instead means the camera *labours* on the climb
 * and runs out along the ridge, and the shape of the hike is legible from the motion alone
 * before any number is read.
 *
 * It also means the flyover and the section agree by construction. Both are functions of the
 * same cumulative-time integral, so the moment the camera reaches the summit is the moment
 * the section's cursor reaches the summit; there is no second model to drift out of sync.
 *
 * Nothing here touches a map library. It produces poses — a point, a heading, a ground height
 * — and leaves projection, pitch and easing to whichever renderer is asking. That is what
 * lets the same path drive MapLibre on the web and MapLibre Native on the phone, and what
 * lets the pacing be tested without a canvas.
 */

/**
 * Screen seconds per modelled hour on the hill.
 *
 * Twelve, which makes a four-hour hike a forty-eight second film. Slow enough that a reader
 * can follow the ground going past and read a waypoint label as it arrives; fast enough that
 * nobody is asked to watch a full day's hike in real time.
 */
export const FLYOVER_MS_PER_HIKING_HOUR = 12_000;

/**
 * Floor and ceiling on the running time.
 *
 * The floor stops a twenty-minute stroll from being over before the terrain has even finished
 * loading — below about fifteen seconds a flyover reads as a glitch rather than a tour. The
 * ceiling matters more: the Pacific Crest Trail is in this database at 4,265 km, which is
 * something like three thousand hours of hiking, and without a ceiling its flyover would run
 * for ten hours. Clamped, it is a seventy-five second sprint over a continent, which is at
 * least an honest impression of the thing.
 */
export const FLYOVER_MIN_MS = 15_000;
export const FLYOVER_MAX_MS = 75_000;

/**
 * How the camera decides which way it is facing, and why it is a window rather than a point.
 *
 * It used to look at whatever was a hundred and fifty metres further along the tread. That
 * works on a path that goes somewhere, and fails in the two places a real route does not.
 *
 * **Switchbacks.** A hundred and fifty metres of a switchback stack is two and a half legs,
 * and where those legs land depends on which half of one you are standing in — so the target
 * jumps from one side of the stack to the other and back, several times a second, while the
 * camera itself climbs steadily. Measured over the flyover of `comfortably-numb-secret-trail`
 * the camera turned 7,293° in forty-nine seconds: twenty full revolutions to walk 15.7 km up
 * a hill. That is the report this exists to answer.
 *
 * **Long routes.** The Pacific Crest Trail's profile is sampled every 725 m and its flyover
 * crosses 940 m of it per frame, so a hundred-and-fifty-metre window sat *inside one segment*
 * and read that segment's raw OSM heading — a different one every frame. 4,012 of its 4,500
 * frames turned faster than 300°/s; the film was a strobe, not a flight.
 *
 * **The landing.** The other two are about how *wide* the window is. The third is about what
 * happens when there is not enough route left to fill it. Clip it to whatever remains and it
 * narrows to nothing over the final stretch, so the heading reads finer and finer geometry as
 * the film ends — on the Pacific Crest Trail the last frame alone turned 118°, a whip at the
 * exact moment the reader is looking at the summit. So the window slides back rather than
 * shrinking: it keeps its full width and comes to rest on the last stretch of tread. It always
 * contains the camera and reaches as far ahead as there is route to reach.
 *
 * What is measured across that stretch is the displacement from the mean position of its first
 * half to the mean of its second — the direction the route is *making*, not the direction from
 * the camera to some point on it. Legs that double back cancel against each other, and so does
 * the camera's own position among them: standing on the outside of a hairpin no longer tilts
 * the answer the way it does when the vector starts at your feet. It is also what lets the
 * window slide past the camera at the end without the heading reversing.
 *
 * The width is measured in **seconds of film**, because the eye's tolerance is in degrees per
 * second and nothing else here is. Averaging over two seconds of screen time means the heading
 * takes about two seconds to change, at any scale: it is the same rule on a 2 km loop and on a
 * continent, and neither has to be special-cased.
 *
 * Except that Tobler slows the camera exactly where the switchbacks are — two seconds of film
 * on a 25% grade is a hundred and eighty metres of tread, which is back inside the stack. So
 * there is a floor in metres as well, wide enough to hold several legs of one. Four hundred
 * is about six legs of a typical stack, at which point the sideways wobble of the mean is a
 * few metres against a couple of hundred of forward travel, and the camera is steady.
 */
export const FLYOVER_HEADING_S = 2;
export const FLYOVER_HEADING_MIN_M = 400;

/**
 * How many points each half of the window is averaged over.
 *
 * A fixed count rather than a fixed spacing, so the per-frame cost is the same for a 400 m
 * window and a 112 km one — sixty-four binary searches either way, which is nothing against
 * a frame budget. It also keeps the estimate smooth: every sample moves continuously as the
 * camera advances, so the mean does too, and a heading that is a continuous function of
 * progress cannot jump however awkward the geometry under it.
 */
const HEADING_SAMPLES = 32;

/**
 * How the camera height is chosen: one screen width of ground every three and a half seconds.
 *
 * A fixed zoom cannot work, because the flyover's ground speed is not fixed. The duration is
 * clamped at both ends, so a two-kilometre stroll and a four-thousand-kilometre thru-hike are
 * both compressed into somewhere between fifteen and seventy-five seconds — which means the
 * stroll passes under the camera at about a hundred metres a second and the thru-hike at
 * nearly sixty thousand. Held at one zoom, the first is a crawl over an empty hillside and the
 * second is a strobe.
 *
 * Fixing the *screen* speed instead makes both watchable and, more to the point, makes them
 * comparable: the ground goes past at the same rate whatever the route, so what the reader
 * perceives as slow is the camera labouring on a climb rather than the route being short.
 * Three and a half seconds per screen is about the rate at which a label can be read as it
 * crosses — much faster and the toponyms are a smear.
 *
 * Expressed per screen width rather than per pixel so a phone and a desktop show the same
 * *proportion* of ground per second. Three hundred pixels a second is a gentle pan on a
 * 1,024-pixel map and a bolt across a 390-pixel one.
 */
export const FLYOVER_SECONDS_PER_SCREEN = 3.5;

/**
 * Bounds on the camera height, because the speed rule alone would run off both ends.
 *
 * The floor is where a global DEM stops describing terrain and starts describing its own
 * sampling — there is no point pulling further back for a continental route, since the extra
 * ground gained is ground the mesh cannot render honestly anyway. The ceiling is the point at
 * which the camera is closer to the hill than the elevation model's ~90 m spacing, where
 * flying lower buys resolution that does not exist.
 */
export const FLYOVER_MIN_ZOOM = 10.5;
export const FLYOVER_MAX_ZOOM = 15.5;

/**
 * How far the camera is tilted off vertical, degrees.
 *
 * Steep enough that the horizon is in frame — which is the whole difference between a 3D
 * map and a shaded 2D one, since it is the skyline that tells you a ridge is a ridge. Not so
 * steep that the near ground fills the bottom third of the screen with a texture-stretched
 * blur, which is what happens past about seventy on a 90 m DEM.
 *
 * Above MapLibre's default `maxPitch` of 60, so a map that means to use this has to raise it.
 */
export const FLYOVER_PITCH = 66;

/**
 * How high the camera flies above the route, as a fraction of the route's own relief.
 *
 * The speed rule below decides how fast the ground goes past; on its own it says nothing
 * about how far above it the camera is, and on a mountain route the two are not the same
 * question. A 6.9 km alpine route flown in a minute crosses the ground at 110 m a second, and
 * holding a screen width to three and a half seconds of that puts the camera roughly two
 * hundred metres up — inside the relief. What comes back is a green wash: no skyline, no
 * ridge, no sense of which side of the valley the path takes, and a DEM magnified well past
 * its own sampling.
 *
 * So the camera is also required to clear the ground it is flying over. Fifty-five per cent
 * of the route's relief puts a thousand-metre climb's camera about six hundred metres above
 * the path, which is high enough that the peaks around it read as peaks against the sky and
 * low enough that the route is still plainly the subject rather than a line in a landscape.
 *
 * The floor is for routes with no relief to speak of — a towpath has nothing to clear, but a
 * camera at zero metres is not a camera. Two hundred and fifty metres is below what the speed
 * rule asks for on any route short enough to reach it, so on flat ground this rule is silent.
 */
export const FLYOVER_RELIEF_CLEARANCE = 0.55;
export const FLYOVER_MIN_CLEARANCE_M = 250;

/**
 * Ground resolution of Web Mercator at zoom 0, metres per pixel at the equator.
 *
 * Derived rather than typed out, because the literal it works out to — 78_271.516_964 — is
 * one keystroke from the 156_543 of the older 256-pixel slippy-map convention, and a zoom
 * computed against that one is a whole level too close with nothing to show it is wrong.
 */
const EQUATOR_M_PER_PX = EARTH_CIRCUMFERENCE_M / MERCATOR_WORLD_PX;

/**
 * How far the camera sits from the point it is looking at, in screen heights.
 *
 * MapLibre puts it at `0.5 · height / tan(fov/2)`, and its default field of view of 36.87°
 * makes that exactly one and a half screens. Written as the ratio rather than as a field of
 * view because that is the form both rules below need, and because a renderer that changes
 * its `fov` has changed a fact this module is asserting.
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
 * The zoom to fly the route at, given how big the map is on screen.
 *
 * Two rules, and whichever wants more ground in frame wins: cross a screen width in
 * `FLYOVER_SECONDS_PER_SCREEN`, and stay `FLYOVER_RELIEF_CLEARANCE` of the relief above the
 * path. The first governs a stroll along a canal, the second governs anything with a
 * mountain in it, and taking the looser of the two is what lets one function serve both
 * without the caller having to know which kind of route it is holding.
 *
 * Latitude is taken from the middle of the route rather than passed in, because the caller
 * that knows the viewport is a renderer and the one that knows where the route is is this
 * module. A route long enough for its ends to sit at materially different latitudes is long
 * enough to be at the zoom floor regardless.
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

  // The camera's height above the point it is looking at is the camera-to-centre distance
  // foreshortened by the tilt, so inverting that gives the resolution at which it clears the
  // ground — and a bigger map, holding the zoom, flies higher for free.
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
 * Precompute everything the animation loop must not do per frame.
 *
 * The integral over the profile is O(n) and a long trail has tens of thousands of points; at
 * sixty frames a second that is the difference between a flyover and a slideshow. The loop
 * that consumes this does one binary search per frame and nothing else.
 *
 * Returns `null` rather than an empty plan for a route that cannot be flown — one point, or
 * none. A caller that has to check for null cannot accidentally animate a still.
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
 * The inverse of `timeAtDistanceS` — how far along you are after so many seconds.
 *
 * Exported because it is the pacing, not a detail of it: a test that only checked poses
 * could not tell a Tobler-paced flyover from a constant-speed one without reimplementing
 * this, and the thing most worth protecting is that they differ.
 */
export function distanceAtTimeS(plan: FlyoverPlan, seconds: number): number {
  const { cumTimeS, profile } = plan;
  const last = profile.length - 1;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (seconds >= plan.hikingTimeS) return plan.lengthM;

  // Cumulative time is non-decreasing, so the segment containing `seconds` is a binary
  // search away rather than a scan — which is what keeps this affordable per frame.
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
 * The pose at a point in the flyover, `progress` running 0 → 1.
 *
 * A pure function of `progress`, which is what lets the same call serve a frame loop, a
 * scrub, and a test. Nothing is carried between frames: the smoothing is in the *shape* of
 * the heading window rather than in a filter with a memory, so seeking to the middle of the
 * film gives the same heading as playing to it.
 */
export function poseAt(plan: FlyoverPlan, progress: number): FlyoverPose | null {
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const hikingS = clamped * plan.hikingTimeS;
  const distanceM = distanceAtTimeS(plan, hikingS);
  const center = positionAt(plan.profile, distanceM);
  if (!center) return null;

  // The window: full width, starting at the camera, sliding back off the end of the route
  // rather than narrowing against it.
  const windowM = Math.min(headingWindowM(plan, hikingS), plan.lengthM);
  const fromM = Math.max(0, Math.min(distanceM, plan.lengthM - windowM));
  const halfM = windowM / 2;
  const near = meanPosition(plan.profile, center, fromM, halfM);
  const far = meanPosition(plan.profile, center, fromM + halfM, halfM);

  // Both halves resolving to the same point means the stretch doubles back on itself exactly
  // and has no direction of travel to report. It happened nowhere in ninety million frames of
  // the corpus, but a bearing has to be something, and facing the middle of the ground under
  // the camera is the least wrong thing available.
  let bearing = 0;
  if (near && far && !samePoint(near, far)) bearing = bearingDeg(near, far);
  else if (far && !samePoint(center, far)) bearing = bearingDeg(center, far);

  return { center, bearing, distanceM, eleM: elevationAt(plan.profile, distanceM) };
}

/**
 * How much tread the heading is measured across here — the ground two seconds of film cross,
 * or the floor, whichever is more.
 *
 * Asked of `distanceAtTimeS` rather than of the profile, so the window is the film's own two
 * seconds and not two seconds of some second model. On the flat that is a few hundred metres;
 * on the Pacific Crest Trail it is over thirty kilometres; on a headwall it is almost nothing,
 * which is what the floor is for.
 *
 * The span is anchored to its *end* rather than to the camera, so it too slides rather than
 * shrinking. Ask "how far do the next two seconds reach" near the finish and the answer decays
 * to zero, which is how the last frames ended up reading single OSM segments; ask "how far
 * does a two-second span ending here reach" and the answer stays the width of two seconds all
 * the way to the credits.
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
 * The mean position of `windowM` of tread starting at `fromM`.
 *
 * Sampled at the midpoint of each of `HEADING_SAMPLES` equal strips rather than at their far
 * edges, which costs a subtraction and makes the mean unbiased: an edge-sampled window is
 * half a strip further along the route than it claims to be, and both halves of the heading
 * carry that error in the same direction, so the corner of a hairpin comes out a couple of
 * degrees off centre. On a 400 m window with 32 strips the offset is 6 m, which is small but
 * is the kind of small that shows up as a permanent lean rather than as noise.
 *
 * Longitudes are averaged as offsets from `origin` rather than outright, because a route
 * either side of the antimeridian carries values near +180 and near −180 whose arithmetic
 * mean is somewhere near Africa. Wrapping each offset into ±180 first costs one modulo and
 * removes the whole class.
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
 * A single still that shows the shape of the route, for readers who have asked for less
 * motion.
 *
 * Not a consolation prize. `prefers-reduced-motion` is a vestibular setting, and a pitched
 * camera sweeping over terrain is close to the worst thing a map can do to someone who has
 * set it — so the flyover does not run for them at all. But the *reason* to want a flyover is
 * to understand how the ground is arranged, and that survives being still: pitch the map,
 * put the high point in the middle of the frame, and face it from the body of the hike.
 *
 * From the mid-distance point rather than from the trailhead because a great many routes
 * start in the trees directly below the summit, and a bearing taken there points at a
 * hillside with the top of it hidden behind the top of it.
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

/**
 * Close enough that a bearing between the two would be noise.
 *
 * A hundredth of a degree is roughly a metre of latitude — below the accuracy of anything
 * feeding this and well below the look-ahead, so two points this close are the same point as
 * far as a heading is concerned.
 */
function samePoint(a: LngLat, b: LngLat): boolean {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}
