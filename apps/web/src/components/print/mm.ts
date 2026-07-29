import { MM_PER_CSS_PX, type SheetSizeMm } from '@switchback/geo';

/**
 * Millimetres, and the one place they have to agree with pixels.
 *
 * The sheet is laid out in real millimetres because that is what the printer will honour:
 * CSS defines an inch as exactly 96 px, so a `199mm` box comes out 199 mm wide on paper no
 * matter what the screen does with it. `@switchback/geo`'s sheet maths works in the same
 * unit, and between them the ratio printed in the collar is the ratio the ruler measures.
 *
 * MapLibre is the exception, and it is the reason this module exists. `Map` sizes its canvas
 * from `container.clientWidth` / `clientHeight`, which are **integers** — a 211 mm face is
 * 797.48 CSS px and MapLibre will lay out 797 of them. Half a pixel is nothing on screen and
 * a tenth of a millimetre on paper, but it is not nothing where it lands: the SVG that draws
 * the route projects continuous millimetres through `sheetPointMm`, and the map underneath
 * projects rounded pixels. The route would sit fractionally off its own valley, and the
 * error would grow toward the neatline where the graticule ticks are supposed to prove the
 * sheet is honest.
 *
 * So the face is snapped to whole CSS pixels before anything is measured from it. It costs
 * up to a quarter of a millimetre of paper — invisible, and the sheet has 10 mm of margin
 * to give — and it buys exact agreement between the two projections.
 */

/** The nearest face dimension that is a whole number of CSS pixels. */
export function snapMm(mm: number): number {
  return Math.round(mm / MM_PER_CSS_PX) * MM_PER_CSS_PX;
}

export function snapSizeMm(size: SheetSizeMm): SheetSizeMm {
  return { widthMm: snapMm(size.widthMm), heightMm: snapMm(size.heightMm) };
}

export function mmToPx(mm: number): number {
  return mm / MM_PER_CSS_PX;
}
