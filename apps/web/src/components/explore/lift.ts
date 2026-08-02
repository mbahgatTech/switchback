/**
 * How far the pick card may lift MapLibre's bottom chrome. Its own module so the geometry can be
 * tested without mounting a map.
 */

/**
 * The tallest of MapLibre's bottom corner columns, plus its own 10 px inset. Measured at
 * 320 px: the zoom pair is 80 px and the scale bar 32.
 */
export const MAP_CHROME_PX = 80;

/** Pane left showing above the lifted chrome, so it sits on the map rather than on its edge. */
export const LIFT_HEADROOM_PX = 8;

/**
 * The most the pick card may lift MapLibre's bottom chrome. The lift is a bottom margin on
 * containers anchored to `bottom: 0`, so past `pane.height - MAP_CHROME_PX` the taller column
 * leaves the pane: unclamped, a 71-character title made a 282 px card, a 306 px lift and a zoom
 * pair at y = −14 on a 320 px phone. Above the ceiling the card overlaps the chrome instead,
 * which is the right way round — the card can be dismissed, a control off the screen cannot.
 */
export function liftCeiling(paneHeight: number): number {
  return Math.max(0, Math.round(paneHeight - MAP_CHROME_PX - LIFT_HEADROOM_PX));
}
