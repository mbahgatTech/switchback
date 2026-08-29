import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ElevationPoint, LngLat } from '@switchback/core';
import {
  advanceProgress,
  buildHikePlan,
  haversineM,
  type HikePlan,
  type RouteProgress,
} from '@switchback/geo';
import { ProgressProfile } from '../src/components/record/progress-profile';

/**
 * The recording screen's progress readings: that the strip draws what the recorder gives it,
 * and that the map and the strip are drawing the same value rather than each finding their own.
 */

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const source = (relative: string) => readFileSync(path.join(webRoot, relative), 'utf8');

/** A 4 km climb from 200 m to 600 m, sampled every 200 m. */
const profile: ElevationPoint[] = Array.from({ length: 21 }, (_, i) => ({
  distM: i * 200,
  eleM: 200 + i * 20,
  lng: -122 + i * 0.001,
  lat: 45,
}));

const plan = buildHikePlan(profile, { routeType: 'point_to_point', lengthM: 4000 })!;

/** Progress a quarter of the way up, as `advanceProgress` would report it. */
const quarterWay = advanceProgress(plan, null, { alongM: 1000, closest: [-122, 45] });

function markup(progress: RouteProgress | null): string {
  return renderToStaticMarkup(
    createElement(ProgressProfile, { plan, progress, trailName: 'Test Ridge', units: 'metric' }),
  );
}

describe('the progress strip', () => {
  it('puts its marker where the recorder says the hiker is', () => {
    const cx = /<circle cx="([\d.]+)"/.exec(markup(quarterWay))?.[1];
    // A quarter along a 320-unit viewBox.
    expect(Number(cx)).toBeCloseTo(80, 1);
  });

  it('draws the shape but no marker before the first fix', () => {
    const html = markup(null);
    expect(html).toContain('<polyline');
    expect(html).not.toContain('<circle');
  });

  it('says the distance and the ascent still to come, in words and in figures', () => {
    const html = markup(quarterWay);
    expect(html).toContain('3.0 km');
    expect(html).toContain('to go');
    expect(html).toContain('300 m');
    expect(html).toContain('to climb');
    expect(html).toMatch(/aria-label="[^"]*3\.0 km and 300 m of climbing left/);
  });

  it('reports the whole trail before there is a position to report', () => {
    expect(markup(null)).toMatch(/aria-label="[^"]*4\.0 km climbing 400 m\."/);
  });

  it('suppresses selection on the plot and nowhere else', () => {
    const html = markup(quarterWay);
    expect(html).toContain('plot-surface');
    expect(/class="[^"]*plot-surface[^"]*"><svg/.test(html)).toBe(true);
  });
});

describe('the map and the strip read one value', () => {
  const recorder = source(path.join('src', 'components', 'record', 'recorder.tsx'));

  it('hands both of them the progress the recorder already computed', () => {
    expect(recorder).toContain('progressAt={recorder.progress?.at ?? null}');
    expect(recorder).toContain('progress={recorder.progress}');
    expect(recorder).toContain('remainingM={recorder.progress?.remainingM ?? null}');
  });

  it('leaves neither of them able to compute a position of its own', () => {
    for (const file of [
      path.join('src', 'components', 'record', 'record-map.tsx'),
      path.join('src', 'components', 'record', 'progress-profile.tsx'),
    ]) {
      expect(source(file), file).not.toMatch(/nearestPointOnLine|advanceProgress/);
    }
  });
});

describe('the strip only mounts when there is a section to draw', () => {
  it('gates on the plan carrying one', () => {
    const recorder = source(path.join('src', 'components', 'record', 'recorder.tsx'));
    expect(recorder).toContain('trail?.plan && trail.plan.profile.length >= 2');
  });

  it('leaves a trail awaiting its elevation pass with a distance and no section', () => {
    const bare = buildHikePlan([], { routeType: 'point_to_point', lengthM: 4000 })!;
    expect(bare.profile).toHaveLength(0);
    expect(advanceProgress(bare, null, { alongM: 1000, closest: [-122, 45] }).remainingM).toBe(
      3000,
    );
  });
});

/** The same 4 km climb walked out and back: 8 km of hiking over 4 km of mapped line. */
const roundTrip = buildHikePlan(profile, { routeType: 'out_and_back', lengthM: 8000 })!;

/** The ground a fix that far along the mapped line projects onto — the recorder's `closest`. */
function groundAt(distanceM: number): LngLat {
  return pointAt(profile, distanceM);
}

function pointAt(points: readonly ElevationPoint[], distanceM: number): LngLat {
  const last = points.length - 1;
  if (distanceM <= points[0]!.distM) return [points[0]!.lng, points[0]!.lat];
  if (distanceM >= points[last]!.distM) return [points[last]!.lng, points[last]!.lat];

  let i = 1;
  while (points[i]!.distM < distanceM) i++;
  const before = points[i - 1]!;
  const after = points[i]!;
  const t = (distanceM - before.distM) / (after.distM - before.distM);
  return [before.lng + (after.lng - before.lng) * t, before.lat + (after.lat - before.lat) * t];
}

interface Marker {
  /** How far along the hike the marker stands, read back through the plot's own scale. */
  distanceM: number;
  /** The ground beneath it. */
  at: LngLat;
}

/**
 * Where the strip's marker actually landed, measured off the rendered SVG rather than
 * recomputed — the viewBox and the circle both come out of the markup, so a change to either
 * the scale or the value fed to it moves this reading.
 */
function markerOn(hikePlan: HikePlan, progress: RouteProgress): Marker {
  const html = renderToStaticMarkup(
    createElement(ProgressProfile, {
      plan: hikePlan,
      progress,
      trailName: 'Test Ridge',
      units: 'metric',
    }),
  );
  const viewWidth = Number(/viewBox="0 0 ([\d.]+) /u.exec(html)?.[1]);
  const cx = Number(/<circle cx="([\d.]+)"/u.exec(html)?.[1]);
  const drawnM = hikePlan.profile[hikePlan.profile.length - 1]!.distM;
  const distanceM = (cx / viewWidth) * drawnM;

  return { distanceM, at: pointAt(hikePlan.profile, distanceM) };
}

/** Fold a sequence of fixes the way the recorder does, keeping the reading at each. */
function walk(alongMs: readonly number[]): RouteProgress[] {
  const readings: RouteProgress[] = [];
  let previous: RouteProgress | null = null;
  for (const alongM of alongMs) {
    previous = advanceProgress(roundTrip, previous, { alongM, closest: groundAt(alongM) });
    readings.push(previous);
  }
  return readings;
}

/**
 * The invariant an AllTrails-style readout lives or dies by: the mark on the map and the marker
 * on the section are two views of one number, so they cannot come to name different places.
 *
 * `progress.at` stands for the map's mark. `<RecordMap>` does nothing to the `progressAt` prop
 * but wrap it in a GeoJSON point, and that the recorder hands it `recorder.progress.at` is
 * asserted above — so agreeing with `at` is agreeing with the map.
 *
 * Written against an out-and-back because that is the only shape where the two can disagree:
 * on the way home `alongM` falls while the hike advances, and a marker drawn from the wrong one
 * of those runs backwards down the plot while the figures beside it count down to zero.
 */
describe('the map mark and the section marker are one value', () => {
  it('keeps the marker over the ground the map marks, all the way out and back', () => {
    for (const progress of walk([0, 2000, 4000, 2000, 1000, 0])) {
      const marker = markerOn(roundTrip, progress);
      expect(haversineM(marker.at, progress.at), `at ${progress.alongM} m along`).toBeLessThan(1);
      expect(marker.distanceM, `at ${progress.alongM} m along`).toBeCloseTo(
        roundTrip.hikedLengthM - progress.remainingM,
        6,
      );
    }
  });

  it('advances the marker while the hiker walks home, and stops it at the end', () => {
    const homeward = walk([0, 2000, 4000, 2000, 1000, 0]).map(
      (progress) => markerOn(roundTrip, progress).distanceM,
    );

    expect(homeward).toEqual([...homeward].sort((a, b) => a - b));
    // The last fix is back at the trailhead, which on an out-and-back is the finish.
    expect(homeward[homeward.length - 1]).toBeCloseTo(roundTrip.hikedLengthM, 6);
  });

  it('is able to fail: the outward leg drawn under round-trip figures is caught', () => {
    // The defect `hikedProfile` exists to prevent — a section that plots half the walk while
    // the numbers beside it describe all of it. Nothing else in this file notices.
    const half = profile.length;
    const outwardOnly: HikePlan = {
      ...roundTrip,
      profile: roundTrip.profile.slice(0, half),
      gainToM: roundTrip.gainToM.slice(0, half),
    };
    const readings = walk([0, 2000, 4000, 1000]);
    const homeward = readings[readings.length - 1]!;

    expect(haversineM(markerOn(outwardOnly, homeward).at, homeward.at)).toBeGreaterThan(1000);
    expect(haversineM(markerOn(roundTrip, homeward).at, homeward.at)).toBeLessThan(1);
  });
});
