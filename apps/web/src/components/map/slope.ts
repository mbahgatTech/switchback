import type { SlopeBand } from '@switchback/geo';
import { SCHEMES } from '@switchback/ui';

/**
 * Slope-angle shading.
 *
 * The overlay answers one question — *how steep is that* — and it answers it in the two
 * places a hiker asks it: choosing a line on the explore sheet, and reading the ground
 * either side of a route before committing to it.
 *
 * **The plate is survey, and that is the point.** The rule everywhere else in this product
 * is that red belongs to the reader and their safety and to nothing else, which is exactly
 * what slope angle is: not a property of the terrain worth admiring, a property of the
 * terrain that decides whether it releases. The gentler two bands take the contour plate,
 * because 27–35° is still terrain you read rather than terrain that has made a decision
 * about you. The hue changes at 35°, and that is the one threshold worth being able to see
 * without reading a number.
 *
 * Alpha rises monotonically across all five bands, independent of the hue break, so the ramp
 * still reads as "denser is steeper" for a reader who cannot separate the amber from the red.
 * On a safety layer that is not a nicety.
 *
 * Nothing below 27° is painted. Most of any map is gentle, and tinting all of it would make
 * this a filter over the sheet rather than a reading off it.
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
 * The avalanche convention, banded where the evidence actually steps.
 *
 * 27° is the shallowest angle at which a slab is commonly observed to release, and the
 * number most guidance uses for connected and runout terrain. 30° is the classic caution
 * line. 35–45° is where the large majority of slab avalanches start. Above 50° snow tends to
 * shed continuously rather than accumulate into a slab, which makes that ground safer from
 * avalanche and considerably worse to fall down.
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
 * The one zoom slope is ever computed at — and the reason there is only one.
 *
 * Slope angle is not a property of the ground. It is a property of the ground **and the
 * baseline you measure it over**, and terrain is rough at every scale, so a shorter baseline
 * always reads steeper. Measured over the same tile of the Snowdon massif:
 *
 * | DEM zoom | ground sample | median | ≥27° | ≥35° |
 * |---|---|---|---|---|
 * | z11 | 46 m | 13.4° | 11 % | 3 % |
 * | z12 | 23 m | 18.1° | 23 % | 9 % |
 * | z13 | 11.5 m | 26.2° | 47 % | 23 % |
 * | z14 | 5.7 m | 30.0° | 59 % | 33 % |
 *
 * Letting the tile pyramid pick the baseline — the obvious implementation, one slope tile per
 * requested zoom — therefore means the same mountainside is amber at one zoom and red at the
 * next, with nothing but the pinch gesture in between. On a decorative layer that is a
 * cosmetic wobble. On this one it is the layer contradicting itself about whether a slope is
 * in the range that slides, which is the only thing it was put on the map to say.
 *
 * So the baseline is pinned and the picture is scaled. Tiles are generated at **z12 only**;
 * MapLibre resamples them for every other zoom. 35° means 35° wherever you are looking from.
 *
 * z12 rather than z13 because Horn's kernel spans two samples, so z12's baseline is 39–55 m
 * across the world's alpine belt — closest of any pyramid level to the ~60 m that the 30 m
 * DEMs behind published avalanche guidance actually imply. z13 would read a good 8° steeper
 * than that guidance is calibrated for, out of a global model with nothing like the detail to
 * justify it. A layer that cries wolf is a layer that gets switched off.
 *
 * Zoomed in, the overlay goes visibly blocky, and it should: the blocks are the true
 * resolution of the measurement, and a reader who can see them will not believe the layer to
 * five metres.
 */
export const SLOPE_TILE_ZOOM = 12;

/**
 * The map zoom below which nothing paints, which follows from the line above rather than
 * being a separate decision: a 256 px raster source is requested one zoom deeper than the
 * map, so a z12-only source has its first renderable frame at map zoom 11. Named here so the
 * key can say *zoom in* instead of showing a reader an empty ramp.
 */
export const SLOPE_MAP_MIN_ZOOM = SLOPE_TILE_ZOOM - 1;

/** Horn's kernel spans two samples, so this is the run the angle is actually measured over. */
export const SLOPE_BASELINE_M = 46;
