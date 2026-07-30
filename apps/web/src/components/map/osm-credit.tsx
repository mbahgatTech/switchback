import { ATTRIBUTION } from '@switchback/core';

/**
 * The ODbL credit on a map screen, in the two places a folding nav makes it need.
 *
 * ODbL requires attribution wherever the data is shown, and on `/`, `/explore`, `/plan` and
 * `/record` the data is the page. All four set `attributionControl: false` on their MapLibre
 * instance — `trail-map.tsx`, `plan-map.tsx`, `record-map.tsx` — on the argument that a
 * licence line burned into the corner of a canvas is the first thing a basemap swap or a
 * screenshot loses, and is illegible over imagery anyway. That argument holds; its bill is
 * that the credit in the page is the *whole* credit, so it cannot be allowed to fold away.
 *
 * Which it briefly was: routed through the nav's `extra` slot, it landed inside a panel that
 * is `display:none` below 1280px, so every phone and tablet showed OSM data with no
 * attribution on screen at all until the reader opened a control labelled for something else.
 * That is what these two exports exist to stop, and why there are two of them rather than one:
 * the neatline copy and the folded copy are never visible at the same width.
 */

/**
 * The copy that stays out of the fold. Goes in `<SiteNav beside={…}>`.
 *
 * The slot is what hides this at 1280 and up — see `site-nav.tsx` — where the panel is the row
 * again and `OsmCredit` below is the one showing. What this decides is the other threshold: the
 * label shortens rather than disappearing at the width where the long form stops fitting beside
 * a wordmark and a button. 320px cannot hold "© OpenStreetMap contributors" and anything else;
 * 640px can. Both spell the same credit and point at the same copyright page, and the
 * abbreviated form is the concession OSM's own guidance makes for small screens — the same one
 * MapLibre's `attributionControl: { compact: true }` makes.
 *
 * Two spans rather than two links, so there is one anchor in the accessibility tree at any
 * width and its name is whichever form is actually painted.
 */
export function OsmCreditBeside() {
  return (
    <a href={ATTRIBUTION.osm.href} className="rounded-hair hover:text-ink">
      <span className="sm:hidden">© OSM</span>
      <span className="hidden sm:inline">{ATTRIBUTION.osm.label}</span>
    </a>
  );
}

/**
 * The copy inside the fold. Goes in `<SiteNav extra={…}>`.
 *
 * Below `xl` this is the long-form credit one tap behind the index; at `xl` it is the credit
 * in the row, where it has always been, sitting among the other marginal labels.
 */
export function OsmCredit() {
  return (
    <a href={ATTRIBUTION.osm.href} className="rounded-hair hover:text-ink">
      {ATTRIBUTION.osm.label}
    </a>
  );
}
