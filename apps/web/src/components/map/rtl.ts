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
 *
 * **Served from our own origin, and this is not a preference.** This URL is handed to
 * `setRTLTextPlugin`, which passes it to `importScripts` inside MapLibre's worker — and that
 * worker is created from a `blob:` URL, so it inherits this origin rather than the script's.
 * `setRTLTextPlugin` takes no integrity parameter, so there is nowhere to pin a digest even if
 * we wanted to. Pointed at `unpkg.com`, as it was, a bad day at a CDN was arbitrary JavaScript
 * running as us with our readers' session cookies — and `public/sw.js` caches
 * `/_next/static/*` cache-first, so it would have outlived the CDN's own recovery.
 *
 * The file is `public/vendor/mapbox-gl-rtl-text.js`, copied verbatim out of
 * `@mapbox/mapbox-gl-rtl-text@0.3.0`'s published tarball — npm integrity
 * `sha512-OwQplFqAAEYRobrTKm2wiVP+wcpUVlgXXiUMNQ8tcm5gPN5SQRXFADmITdQOaec4LhDhuuFchS7TS8ua8dUl4w==`,
 * and the copy itself is `sha256-d1c69035295613baaf83fe23fd9266b0eaed7e5e472e9632b0b5438afc3f589e`.
 * Its licence sits beside it.
 *
 * **It no longer updates itself.** That is the trade, and it is the point: a dependency that
 * silently changes under you is the thing being fixed. A MapLibre upgrade that expects a newer
 * shaper needs this file refreshed by hand — re-download the pinned version, verify the digest
 * above, and update both. Nothing will fail loudly if that is missed; right-to-left labels will
 * simply keep being shaped by the old build.
 */
const RTL_PLUGIN_URL = '/vendor/mapbox-gl-rtl-text.js';

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
 * The rejection is swallowed on purpose. A file that is blocked or missing is a map with
 * unshaped Arabic on it, which is where we were before; a map that fails to initialise because
 * a font shaper could not be fetched is strictly worse than the bug this fixes.
 */
let registered = false;

export function registerRTLText(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  maplibregl.setRTLTextPlugin(RTL_PLUGIN_URL, true).catch(() => {
    // Left unshaped rather than left unmounted. See above.
  });
}
