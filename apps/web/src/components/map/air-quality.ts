import { AIR_QUALITY_BANDS, type AirQualityGrid } from '@switchback/core';
import { SCHEMES } from '@switchback/ui';

/**
 * Air quality, as a field you can see the edges of.
 *
 * The plate changes at 60, where the European AQI enters "poor" and `AQI_CAUTION` fires:
 * water below (weather is a condition), survey above (it has started describing what the day
 * will do to the reader). Alpha climbs monotonically across all six bands independent of the
 * hue break, so the ramp reads as "denser is worse" without colour.
 *
 * Cells are drawn at the model's own footprint with their own outlines, not blended — a
 * gradient over a 40 km grid would invent numbers nobody computed. A cell the model had no
 * answer for is omitted: a hole is honest, a zero is not.
 */

export const AIR_QUALITY_SOURCE = 'air-quality';
export const AIR_QUALITY_LAYER = 'air-quality-cells';

export interface AirQualityLegendBand {
  /** Lower bound of the band, inclusive — the value the map's `step` expression breaks on. */
  readonly from: number;
  readonly label: string;
  /** As it appears in the key: "40–60", or "100+" for the open-ended top band. */
  readonly range: string;
  readonly fill: string;
  readonly stroke: string;
}

const { water, survey } = SCHEMES.field;

function rgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Fill alpha per band, ascending. The outline runs a little denser so the lattice reads. */
const ALPHAS = [0.1, 0.2, 0.32, 0.46, 0.62, 0.78] as const;

export const AIR_QUALITY_LEGEND: readonly AirQualityLegendBand[] = AIR_QUALITY_BANDS.map(
  (band, index) => {
    const alpha = ALPHAS[index] ?? 0.78;
    const plate = band.from >= 60 ? survey : water;
    return {
      from: band.from,
      label: band.label,
      range: band.to === null ? `${band.from}+` : `${band.from}–${band.to}`,
      fill: rgba(plate, alpha),
      stroke: rgba(plate, Math.min(1, alpha + 0.22)),
    };
  },
);

/**
 * A `step` expression over the cell's own reading. `step` rather than `interpolate` because
 * the bands are legal definitions with hard edges: 59 and 61 are different advice.
 */
function stepOver(pick: (band: AirQualityLegendBand) => string): unknown[] {
  const expression: unknown[] = ['step', ['coalesce', ['get', 'aqi'], 0], pick(first())];
  for (const band of AIR_QUALITY_LEGEND.slice(1)) {
    expression.push(band.from, pick(band));
  }
  return expression;
}

function first(): AirQualityLegendBand {
  return AIR_QUALITY_LEGEND[0]!;
}

export function airQualityFillColor(): unknown[] {
  return stepOver((band) => band.fill);
}

export function airQualityOutlineColor(): unknown[] {
  return stepOver((band) => band.stroke);
}

export interface AirQualityFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { aqi: number };
    geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  }[];
}

export const EMPTY_AIR_QUALITY: AirQualityFeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

/** The grid as polygons, each at the model cell's true footprint. */
export function airQualityFeatures(
  grid: Pick<AirQualityGrid, 'cells'> | null | undefined,
): AirQualityFeatureCollection {
  if (!grid) return EMPTY_AIR_QUALITY;
  return {
    type: 'FeatureCollection',
    features: grid.cells.flatMap((cell) => {
      if (cell.europeanAqi === null) return [];
      const [w, s, e, n] = cell.bbox;
      return [
        {
          type: 'Feature' as const,
          properties: { aqi: cell.europeanAqi },
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
        },
      ];
    }),
  };
}

/**
 * "Moderate — 47" for a headline. Kept beside the colours so a swatch and the prose under it
 * can never call the same number by different names.
 */
export function airQualityBandLabel(aqi: number | null | undefined): string | null {
  if (aqi === null || aqi === undefined) return null;
  const band = [...AIR_QUALITY_LEGEND].reverse().find((entry) => aqi >= entry.from);
  return band?.label ?? null;
}
