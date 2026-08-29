import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ElevationPoint } from '@switchback/core';
import { advanceProgress, buildHikePlan, computeTrailStats } from '@switchback/geo';
import { ProgressProfile } from '../src/components/record/progress-profile';
import { TrailProfile } from '../src/components/trail/profile';

/**
 * That a press-and-hold on either elevation graphic selects nothing.
 *
 * Asserted through the declarations the plot actually resolves to in the shipped stylesheet,
 * not through the spelling of a class name: a test that only looks for `plot-surface` stays
 * green while the rule behind it is changed to `user-select: text`, which is the whole of the
 * defect. So the class comes off the rendered element and is looked up in `globals.css`.
 */

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const globals = readFileSync(path.join(webRoot, 'app', 'globals.css'), 'utf8');

/**
 * The three declarations that make a graphic a gesture surface rather than a paragraph.
 * Safari honours neither unprefixed `user-select` nor an unprefixed callout, and the callout
 * is the one that turns a long press into the system Copy menu — so all three are load-bearing.
 */
const SUPPRESSION: ReadonlyArray<readonly [string, string]> = [
  ['user-select', 'none'],
  ['-webkit-user-select', 'none'],
  ['-webkit-touch-callout', 'none'],
];

/**
 * What a single class resolves to in a stylesheet, by property. Empty when no rule selects it.
 *
 * Reads flat rules at any nesting depth, which is every component class in this stylesheet, and
 * matches a selector only when it is the whole of one entry in the rule's selector list — a rule
 * rewritten as `.something .plot-surface` no longer applies to the plot on its own, and this
 * returning nothing is the honest answer rather than a false pass.
 */
function declarationsFor(css: string, className: string): Map<string, string> {
  const resolved = new Map<string, string>();
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, '');

  for (const rule of source.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
    if (!rule[1]!.split(',').some((selector) => selector.trim() === `.${className}`)) continue;
    for (const declaration of rule[2]!.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      resolved.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }

  return resolved;
}

/** Every declaration the classes on one element resolve to, merged in source order. */
function resolve(css: string, classAttribute: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const className of classAttribute.split(/\s+/u).filter(Boolean)) {
    for (const [property, value] of declarationsFor(css, className)) merged.set(property, value);
  }
  return merged;
}

/** The class attribute of the element wrapping the plot's `<svg>`. */
function plotSurfaceClasses(html: string): string {
  const match = /class="([^"]*)"><svg/u.exec(html);
  if (!match) throw new Error('no element wraps an <svg> in this markup');
  return match[1]!;
}

const climb: ElevationPoint[] = Array.from({ length: 21 }, (_, i) => ({
  distM: i * 200,
  eleM: 200 + i * 20,
  lng: -122 + i * 0.001,
  lat: 45,
}));

const plan = buildHikePlan(climb, { routeType: 'point_to_point', lengthM: 4000 })!;

const PLOTS: ReadonlyArray<readonly [string, () => string]> = [
  [
    'the recording screen’s progress strip',
    () =>
      renderToStaticMarkup(
        createElement(ProgressProfile, {
          plan,
          progress: advanceProgress(plan, null, { alongM: 1000, closest: [-122, 45] }),
          trailName: 'Test Ridge',
          units: 'metric',
        }),
      ),
  ],
  [
    'the trail page’s section',
    () =>
      renderToStaticMarkup(
        createElement(TrailProfile, {
          profile: climb,
          stats: computeTrailStats(climb),
          units: 'metric',
          cursorDistanceM: null,
          onCursorChange: () => {},
        }),
      ),
  ],
];

describe('a press-and-hold on an elevation graphic selects nothing', () => {
  for (const [name, render] of PLOTS) {
    it(`suppresses selection on ${name}, through the stylesheet that ships`, () => {
      const declared = resolve(globals, plotSurfaceClasses(render()));
      for (const [property, value] of SUPPRESSION) {
        expect(declared.get(property), `${name}: ${property}`).toBe(value);
      }
    });
  }

  it('leaves the figures beside the plot selectable, which is where the numbers are', () => {
    const html = PLOTS[0]![1]();
    const surface = /<div class="[^"]*plot-surface[^"]*">(.*?)<\/svg>/su.exec(html)?.[1] ?? '';
    // `user-select` inherits, so the guarantee is structural: nothing but the graphic is inside.
    expect(surface.startsWith('<svg')).toBe(true);
    expect(html).toContain('to go');
    expect(surface).not.toContain('to go');
  });

  it('reports the declared value, so weakening the rule cannot pass as suppressing', () => {
    const weakened = '@layer components { .plot-surface { user-select: text; } }';
    expect(declarationsFor(weakened, 'plot-surface').get('user-select')).toBe('text');
    expect(declarationsFor(globals, 'no-such-class').size).toBe(0);
  });
});
