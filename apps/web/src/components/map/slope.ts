import type { SlopeBand } from '@switchback/geo';
import { SCHEMES } from '@switchback/ui';

/**
 * Slope-angle shading, in the survey plate: slope angle is what decides whether terrain
 * releases, so it is one of the few things allowed the safety colour. The gentler two bands
 * take contour, and the hue breaks at 35°.
 *
 * Alpha rises monotonically across all five bands independent of the hue break, so the ramp
 * still reads as "denser is steeper" without colour. Nothing below 27° is painted.
 */

export interface SlopeLegendBand extends SlopeBand {
  /** As it appears in the key, e.g. "35–45". The degree sign is carried by the axis. */
  readonly range: string;
  /** CSS colour for the legend swatch, at the same alpha the map paints with. */
  readonly css: string;
}

/** One band, from a plate and an opacity — the two representations kept in step by hand. */
function band(fromDeg: number, range: string, hex: string, alpha: number): SlopeLegendBand {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return {
    fromDeg,
    range,
    rgba: [r, g, b, Math.round(alpha * 255)] as const,
    css: `rgba(${r}, ${g}, ${b}, ${alpha})`,
  };
}

const { contour, survey } = SCHEMES.field;

/**
 * The avalanche convention, banded where the evidence steps: 27° is the shallowest angle a
 * slab is commonly observed to release at, 30° the classic caution line, 35–45° where the
 * large majority of slab avalanches start, and above 50° snow sheds rather than accumulates.
 */
export const SLOPE_BANDS: readonly SlopeLegendBand[] = [
  band(27, '27–30', contour, 0.28),
  band(30, '30–35', contour, 0.42),
  band(35, '35–45', survey, 0.58),
  band(45, '45–50', survey, 0.74),
  band(50, '50+', survey, 0.9),
] as const;

/** Custom MapLibre protocol. Registered by `registerSlopeProtocol`, computed in the browser. */
export const SLOPE_PROTOCOL = 'slope';
export const SLOPE_SOURCE = 'slope-angle';
export const SLOPE_LAYER = 'slope';
export const SLOPE_TILE_URL = `${SLOPE_PROTOCOL}://{z}/{x}/{y}`;

/**
 * The one zoom slope is ever computed at. Slope angle is a property of the ground *and the
 * baseline it is measured over*, and terrain is rough at every scale, so letting the tile
 * pyramid pick the baseline makes the same mountainside amber at one zoom and red at the next.
 * Tiles are generated at z12 only and MapLibre resamples them, so 35° means 35° everywhere.
 *
 * z12 rather than z13 because Horn's kernel spans two samples, putting the baseline at
 * 39–55 m across the alpine belt — closest of any pyramid level to the ~60 m implied by the
 * 30 m DEMs behind published avalanche guidance. The blockiness when zoomed in is honest.
 */
export const SLOPE_TILE_ZOOM = 12;

/**
 * The map zoom below which nothing paints. A 256 px raster source is requested one zoom deeper
 * than the map, so a z12-only source first renders at map zoom 11. Named so the key can say
 * *zoom in* rather than showing an empty ramp.
 */
export const SLOPE_MAP_MIN_ZOOM = SLOPE_TILE_ZOOM - 1;

/** Horn's kernel spans two samples, so this is the run the angle is actually measured over. */
export const SLOPE_BASELINE_M = 46;
