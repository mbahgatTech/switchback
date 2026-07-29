import maplibregl from 'maplibre-gl';

/**
 * Where the right-to-left text shaper comes from.
 *
 * Mapbox's, because it is the only implementation of this that exists — MapLibre forked the
 * renderer but not this, and its own documentation points at the same file. It is a ~200 KB
 * WASM-adjacent bundle implementing the Unicode bidirectional algorithm and Arabic contextual
 * shaping, which is why it is a plugin at all rather than part of the renderer: the great
 * majority of maps never draw a right-to-left name and should not pay for the code that
 * would.
 */
const RTL_PLUGIN_URL =
  'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js';

/**
 * Teach MapLibre to shape Arabic, Hebrew, Persian and Urdu. Call from every map's init.
 *
 * Without this, MapLibre lays right-to-left text out left-to-right in codepoint order and
 * draws every letter in its isolated form. What reaches the screen is not merely ugly: it is
 * the name backwards, with the letters unjoined, which a reader of Arabic cannot read either.
 * Nobody is served by it — not the reader who wanted English, and not the reader who wanted
 * the local name. That is why this is a defect rather than a nicety, and why it is registered
 * even though `LABEL_NAME` prefers a Latin name wherever the tiles carry one: preference is
 * not guarantee, and the features that fall through to the local name are exactly the small
 * unglamorous ones — a spring, a col, a hamlet — that a hiker in the Atlas or the Negev is
 * navigating by.
 *
 * `lazy: true` defers the download until a right-to-left glyph is actually encountered, so a
 * reader who never leaves the Cascades never fetches it. The trade is that the first Arabic
 * tile renders unshaped for the length of one network round trip and is then re-laid out;
 * eager loading would spend the 200 KB on every map in the product to avoid a flash almost
 * nobody sees.
 *
 * Registration is global to the maplibre module and permanent — the same reasoning as
 * `registerSlopeProtocol`, and the same guard. Calling it twice throws rather than no-ops,
 * and two maps mounted at once is ordinary here.
 *
 * The rejection is swallowed on purpose. A CDN that is blocked or down is a map with unshaped
 * Arabic on it, which is where we were before; a map that fails to initialise because a font
 * shaper could not be fetched is strictly worse than the bug this fixes.
 */
let registered = false;

export function registerRTLText(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  maplibregl.setRTLTextPlugin(RTL_PLUGIN_URL, true).catch(() => {
    // Left unshaped rather than left unmounted. See above.
  });
}
