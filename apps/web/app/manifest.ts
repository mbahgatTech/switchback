import type { MetadataRoute } from 'next';
import { BRAND } from '@switchback/core/brand';
import { PALETTES } from '@switchback/ui';

/**
 * The web app manifest.
 *
 * This is what makes the site installable, and installable is not a badge — it is the
 * difference between a downloaded trail you can open from the home screen with no signal and
 * one you can only reach by typing a URL into a browser that is showing an error page.
 *
 * `display: standalone` rather than `fullscreen`: the status bar carries the clock and the
 * battery, and both of those matter more on a hill than the forty pixels they occupy.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: BRAND.tagline,
    // Where a cold launch lands, and now the same path as `scope` — the front page is the
    // map, so an installed app opens the instrument with no alias anywhere in the install
    // path. That matters more than it sounds: the start URL is what the service worker
    // precaches, and a shell keyed to a route that is only an alias is one rename from
    // launching straight into the offline fallback.
    start_url: '/',
    /*
     * The application's identity, and it is `/explore` on purpose.
     *
     * When `id` is absent the spec falls back to the resolved `start_url`, so every copy of
     * this app installed before the front page moved recorded its identity as
     * `https://<host>/explore`. Shipping `start_url: '/'` with no `id` would have handed the
     * browser an identifier it had never seen: not an update to the installed app but a
     * second, different one — the existing install frozen forever on the old start URL, no
     * name or icon changes ever again, and an offer to install a duplicate beside it.
     *
     * So the identity stays where the field already put it, and the start URL moves under it.
     * `id` resolves against the manifest's *origin* rather than against `start_url`, so this
     * is `https://<host>/explore` and matches what is already recorded. It is now permanent:
     * changing this string later orphans every install exactly as described above, whatever
     * `start_url` says at the time.
     */
    id: '/explore',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: PALETTES.dark.field.canvas,
    /*
     * The splash, and the chrome for the half-second before the document is parsed.
     *
     * A manifest is one static file. It cannot ask `prefers-color-scheme`, so unlike
     * `generateViewport()` in the root layout — which hands the browser both answers and
     * lets it choose — this has to commit to one, and the layout's `<meta name="theme-color">`
     * takes over the moment the page arrives either way.
     *
     * Dark, and named as `PALETTES.dark` rather than borrowed from `SCHEMES`, which is the
     * same value under a name that reads mode-agnostic and is how the comment that used to
     * sit here came to claim a match that only held half the time. A launch that resolves
     * out of a dark splash into a light map is a beat of paper; the reverse is a flash of
     * white in somebody's face, and this is an app that gets opened at dawn and in tents.
     */
    theme_color: PALETTES.dark.field.canvas,
    categories: ['navigation', 'travel', 'sports'],
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Same art, declared maskable — drawn inside the safe zone so a launcher can crop it
      // to whatever shape it likes without taking a corner off the blaze.
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      {
        name: 'Record a hike',
        short_name: 'Record',
        description: 'Start tracking from wherever you are standing.',
        url: '/record',
      },
      {
        name: 'Downloads',
        short_name: 'Downloads',
        description: 'Trails you have taken offline.',
        url: '/downloads',
      },
    ],
  };
}
