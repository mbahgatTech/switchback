import { HEATMAP_BANDS, type Heatmap } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';

/**
 * The activity heatmap, as a wash of desire lines.
 *
 * **Ink, the culture plate.** On a USGS quadrangle the culture plate carries the works of
 * man — roads, buildings, boundaries, everything people put there. Busy times already claims
 * it for *when people go*; this is the same fact in plan rather than in section, so it takes
 * the same plate. The other four are spoken for and none of them would be honest here:
 * woodland is the trail itself and the overlay would be indistinguishable from the thing it
 * sits on top of, water is weather, contour is elevation, and survey means the reader's own
 * safety, which is not what a record of other people's hikes is about.
 *
 * **No outlines, deliberately unlike the air-quality grid.** That layer draws its seams
 * because the lattice *is* the upstream model's resolution — the edges are a fact about how
 * much the model knows, and hiding them would overstate it. Here the lattice is our own
 * display choice, resized at every zoom, and drawing its seams would advertise a resolution
 * nobody computed. `fill-antialias` goes off for the same reason: adjacent translucent
 * polygons antialias against each other and leave a hairline grid of exactly the seams this
 * layer is trying not to claim.
 *
 * **Absolute bands, never normalised to the viewport.** Tempting to scale colour against the
 * busiest cell on screen — it would make every view look informative. It would also mean the
 * same ground changes colour under a pan, and that a dark cell means "busy here" in one
 * viewport and "busy for around here" in the next. Fixed thresholds cost some contrast on a
 * quiet map and buy a colour that means one thing everywhere, which is the only kind a key
 * can print numbers for.
 *
 * Alpha climbs and hue does not. There is one fact being shown, in one dimension, and a
 * second dimension of colour would imply a second fact.
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
 * Fill alpha per band, ascending, and the top one stops a long way short of opaque.
 *
 * The numbers are low because on the field scheme the culture plate is a near-white against a
 * dark canvas, and a near-white area fill is the most destructive thing you can put on a map:
 * at anything above about half opacity it stops reading as *ink over ground* and starts
 * reading as ground that has been erased. A hairline of this colour can be emphatic because it
 * covers nothing; a 150 m square cannot.
 *
 * So the ramp is built the other way round from a line's. It starts at the threshold of
 * visibility and roughly doubles at each step, which keeps five bands separable across a range
 * narrow enough that the relief tint, the contours and the trail lines all survive underneath
 * — and surviving underneath is the entire point. A bright wash where no line is drawn is a
 * path OSM has never heard of; a green line with no wash on it is a trail nobody hikes. Both
 * readings need the two layers legible at once.
 */
const ALPHAS = [0.06, 0.12, 0.21, 0.34, 0.5] as const;

export const HEATMAP_LEGEND: readonly HeatmapLegendBand[] = HEATMAP_BANDS.map((band, index) => ({
  from: band.from,
  label: band.label,
  range: band.to === null ? `${band.from}+` : `${band.from}–${band.to}`,
  fill: rgba(ink, ALPHAS[index] ?? 0.5),
}));

/**
 * A `step` expression over the cell's visit count.
 *
 * `step` and not `interpolate`, for a different reason than the air-quality layer's. There
 * the bands are legal definitions with hard edges. Here they are a logarithmic ladder over a
 * count, and interpolating between them would render the difference between four visits and
 * nine as a visible gradient — which is a precision the k-anonymity floor has already
 * removed, and which the reader would take for signal.
 */
export function heatmapFillColor(): unknown[] {
  const expression: unknown[] = [
    'step',
    ['coalesce', ['get', 'visits'], 0],
    // Below the first band nothing should ever be drawn, because nothing below it is ever
    // returned. Fully transparent rather than a faint tint, so a bug upstream shows up as a
    // hole rather than as plausible-looking traffic.
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
