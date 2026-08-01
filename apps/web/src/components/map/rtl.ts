import maplibregl from 'maplibre-gl';

/**
 * Mapbox's right-to-left text shaper, served from our own origin — not a preference.
 * `setRTLTextPlugin` hands this URL to `importScripts` inside a worker created from a `blob:`
 * URL, so it runs as us, and the API takes no integrity parameter to pin a digest with.
 *
 * `public/vendor/mapbox-gl-rtl-text.js` is copied verbatim from
 * `@mapbox/mapbox-gl-rtl-text@0.3.0`; the copy is
 * `sha256-d1c69035295613baaf83fe23fd9266b0eaed7e5e472e9632b0b5438afc3f589e`. It does not
 * update itself: a MapLibre upgrade needing a newer shaper must refresh it by hand, and
 * nothing fails loudly if that is missed.
 */
const RTL_PLUGIN_URL = '/vendor/mapbox-gl-rtl-text.js';

/**
 * Teach MapLibre to shape Arabic, Hebrew, Persian and Urdu. Call from every map's init —
 * without it right-to-left names are drawn backwards with unjoined letters, which no reader
 * can use. Needed even though `LABEL_NAME` prefers Latin: preference is not guarantee.
 *
 * `lazy: true` defers the 200 KB download until a right-to-left glyph is encountered.
 * Registration is global and permanent, and calling it twice throws rather than no-ops, so
 * the guard matters when two maps mount at once.
 */
let registered = false;

export function registerRTLText(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  maplibregl.setRTLTextPlugin(RTL_PLUGIN_URL, true).catch(() => {
    // Unshaped is better than a map that fails to initialise because a shaper 404'd.
  });
}
