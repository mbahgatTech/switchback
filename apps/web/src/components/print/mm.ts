import { MM_PER_CSS_PX, type SheetSizeMm } from '@switchback/geo';

/**
 * Millimetres, and the one place they have to agree with pixels. MapLibre sizes its canvas from
 * `container.clientWidth`, which is an integer, while the SVG that draws the route projects
 * continuous millimetres — so the face is snapped to whole CSS pixels before anything is
 * measured from it, or the route sits fractionally off its own valley.
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
