import { describe, expect, it } from 'vitest';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { UNIT_SYSTEMS } from '@switchback/core';
import { BASEMAPS, buildStyle, peakTextField } from '../src/components/map/basemap';
import { printSheetStyle } from '../src/components/print/sheet-style';

/**
 * The map's own lettering, which two audits walked straight past.
 *
 * `units` site-wide and the design-conventions sweep both checked components and Tailwind
 * classes. Neither opened a MapLibre style expression, so the labels kept saying `name` — the
 * local-language field, which puts an Arabic summit on an English map — and kept printing
 * summit heights in metres under an imperial stat table. Both defects lived in an array of
 * strings that reads as configuration and behaves as code.
 *
 * So these are assertions about expressions rather than about pixels. Rendering is MapLibre's
 * job and it is tested upstream; what is ours is which field a label reads and which unit it
 * prints, and both are decidable by walking the style object.
 *
 * Imported by relative path: `@/` is a Next.js alias and the unit suite runs from the repo
 * root, where it does not resolve.
 */

/** Every `text-field` in a style, whatever depth of layer it is on. */
function textFields(style: StyleSpecification): unknown[] {
  return style.layers
    .map((layer: LayerSpecification) =>
      'layout' in layer ? (layer.layout as { 'text-field'?: unknown } | undefined) : undefined,
    )
    .map((layout) => layout?.['text-field'])
    .filter((field) => field !== undefined);
}

describe('map labels', () => {
  for (const base of BASEMAPS) {
    for (const units of UNIT_SYSTEMS) {
      it(`prefers a transliterated name on ${base.id} in ${units}`, () => {
        const fields = textFields(buildStyle(base.id, { hillshade: true, units }));
        // Satellite carries labels too — it is imagery with our lettering over it, not a
        // bare photograph — so no base is allowed to have none.
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
          const source = JSON.stringify(field);
          expect(source).toContain('name:en');
          expect(source).toContain('name:latin');
          // The bug itself: a label that reads only the local-language field.
          expect(field).not.toEqual(['get', 'name']);
        }
      });
    }
  }

  it('labels the print sheet the same way', () => {
    for (const units of UNIT_SYSTEMS) {
      const fields = textFields(printSheetStyle(["Llyn Du'r Arddu"], units));
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        // Waypoint labels are our own names, taken from the feature we put there. Only the
        // borrowed ones — places, water, peaks — have a language to get wrong.
        const source = JSON.stringify(field);
        if (source.includes('name')) expect(source).toContain('name:en');
      }
    }
  });
});

describe('peak heights', () => {
  it('prints metres for a metric reader', () => {
    const source = JSON.stringify(peakTextField('metric'));
    expect(source).toContain('" m"');
    expect(source).not.toContain('ft');
  });

  it('prints feet for an imperial reader', () => {
    const source = JSON.stringify(peakTextField('imperial'));
    expect(source).toContain('" ft"');
    expect(source).not.toContain('" m"');
    // The tiles ship `ele_ft` already converted. Preferring it over our own arithmetic is
    // what keeps the map and the stat table from disagreeing by a rounding convention.
    expect(source).toContain('ele_ft');
  });

  it('falls back to the name alone where a peak has no height', () => {
    // `ele` is optional in OpenMapTiles, and `['round', undefined]` renders the string
    // "null m" rather than nothing at all.
    for (const units of UNIT_SYSTEMS) {
      expect(JSON.stringify(peakTextField(units))).toContain('"has","ele"');
    }
  });

  it('reaches the map itself, on every base that has peaks', () => {
    for (const units of UNIT_SYSTEMS) {
      const style = buildStyle('relief', { hillshade: true, units });
      // `peak-labels`, not `peak`: the tier also carries a `peak-marks` circle beneath the
      // lettering, and a circle has nothing to say.
      const peaks = style.layers.filter((layer) => layer.id.includes('peak-labels'));
      expect(peaks.length).toBeGreaterThan(0);
      const expected = JSON.stringify(peakTextField(units));
      for (const layer of peaks) {
        const layout = 'layout' in layer ? (layer.layout as { 'text-field'?: unknown }) : {};
        expect(JSON.stringify(layout['text-field'])).toBe(expected);
      }
    }
  });
});
