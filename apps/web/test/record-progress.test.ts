import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ElevationPoint } from '@switchback/core';
import { advanceProgress, buildHikePlan, type RouteProgress } from '@switchback/geo';
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
