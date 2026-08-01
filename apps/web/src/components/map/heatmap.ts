import { HEATMAP_BANDS, type Heatmap } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';

/**
 * The activity heatmap, as a wash of desire lines in the ink (culture) plate.
 *
 * No outlines and `fill-antialias` off, unlike the air-quality grid: this lattice is our own
 * display choice, resized at every zoom, so drawing its seams would advertise a resolution
 * nobody computed. Bands are absolute, never normalised to the viewport, so the same ground
 * keeps its colour under a pan and the key can print numbers. Alpha climbs and hue does not.
 */

export const HEATMAP_SOURCE = 'activity-heatmap';
export const HEATMAP_LAYER = 'activity-heatmap-cells';

export interface HeatmapLegendBand {
  /** Lower bound in visits, inclusive — the value the map's `step` expression breaks on. */
  readonly from: number;
  readonly label: string;
  /** As it appears in the key: "30–100", or "300+" for the open-ended top band. */
  readonly range: string;
  readonly fill: string;
}

const { ink } = SCHEMES.field;

function rgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Fill alpha per band, ascending, stopping a long way short of opaque: the culture plate is a
 * near-white on the field scheme, and above about half opacity an area fill of it reads as
 * ground erased rather than ink over ground. The relief tint, contours and trail lines all
 * have to stay legible underneath — a wash with no line on it is a path OSM has not heard of.
 */
const ALPHAS = [0.06, 0.12, 0.21, 0.34, 0.5] as const;

export const HEATMAP_LEGEND: readonly HeatmapLegendBand[] = HEATMAP_BANDS.map((band, index) => ({
  from: band.from,
  label: band.label,
  range: band.to === null ? `${band.from}+` : `${band.from}–${band.to}`,
  fill: rgba(ink, ALPHAS[index] ?? 0.5),
}));

/**
 * A `step` expression over the cell's visit count. `step` rather than `interpolate` because
 * the bands are a logarithmic ladder: a gradient between four visits and nine would show a
 * precision the k-anonymity floor has already removed.
 */
export function heatmapFillColor(): unknown[] {
  const expression: unknown[] = [
    'step',
    ['coalesce', ['get', 'visits'], 0],
    // Nothing below the first band is ever returned. Fully transparent rather than a faint
    // tint, so a bug upstream shows up as a hole rather than as plausible-looking traffic.
    'rgba(0, 0, 0, 0)',
  ];
  for (const band of HEATMAP_LEGEND) {
    expression.push(band.from, band.fill);
  }
  return expression;
}

export interface HeatmapFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { visits: number; hikers: number };
    geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  }[];
}

export const EMPTY_HEATMAP: HeatmapFeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/** The grid as polygons, each exactly one lattice cell. */
export function heatmapFeatures(
  grid: Pick<Heatmap, 'cells'> | null | undefined,
): HeatmapFeatureCollection {
  if (!grid) return EMPTY_HEATMAP;
  return {
    type: 'FeatureCollection',
    features: grid.cells.map((cell) => {
      const [w, s, e, n] = cell.bbox;
      return {
        type: 'Feature' as const,
        properties: { visits: cell.visits, hikers: cell.hikers },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ] as [number, number][],
          ],
        },
      };
    }),
  };
}

/** "Well hiked" for a count, so a tooltip and a swatch can never disagree. */
export function heatmapBandLabel(visits: number | null | undefined): string | null {
  if (visits === null || visits === undefined) return null;
  const band = [...HEATMAP_LEGEND].reverse().find((entry) => visits >= entry.from);
  return band?.label ?? null;
}
