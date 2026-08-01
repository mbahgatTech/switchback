import { ATTRIBUTION } from '@switchback/core';

/**
 * The ODbL credit for map screens. Every map sets `attributionControl: false`, so the credit
 * in the page is the whole credit and must never fold away — hence two exports, one for the
 * neatline and one for the folded panel, never visible at the same width.
 */

/**
 * The copy that stays out of the fold. Goes in `<SiteNav beside={…}>`; the slot hides it at
 * 1280 and up. The label shortens below `sm` rather than disappearing — the concession OSM's
 * own guidance makes for small screens. Two spans rather than two links, so there is one
 * anchor in the accessibility tree at any width.
 */
export function OsmCreditBeside() {
  return (
    <a href={ATTRIBUTION.osm.href} className="rounded-hair hover:text-ink">
      <span className="sm:hidden">© OSM</span>
      <span className="hidden sm:inline">{ATTRIBUTION.osm.label}</span>
    </a>
  );
}

/** The copy inside the fold. Goes in `<SiteNav extra={…}>`; shows in the row at `xl`. */
export function OsmCredit() {
  return (
    <a href={ATTRIBUTION.osm.href} className="rounded-hair hover:text-ink">
      {ATTRIBUTION.osm.label}
    </a>
  );
}
