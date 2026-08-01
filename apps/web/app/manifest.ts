import type { MetadataRoute } from 'next';
import { BRAND } from '@switchback/core/brand';
import { PALETTES } from '@switchback/ui';

/**
 * The web app manifest — what makes the site installable, so a downloaded trail can be opened
 * from the home screen with no signal. `standalone` rather than `fullscreen`: the status bar
 * carries the clock and the battery, which matter more on a hill than the pixels they take.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: BRAND.tagline,
    // Same path as `scope`, and the same path the service worker precaches — a shell keyed to
    // an alias is one rename from launching straight into the offline fallback.
    start_url: '/',
    /*
     * **Permanent. Do not change this string.** `id` is the application's identity; when it is
     * absent the spec falls back to the resolved `start_url`, so every copy installed before the
     * front page moved recorded itself as `https://<host>/explore`. Editing it orphans every
     * existing install — frozen on its old start URL, never updating its name or icon again,
     * with an offer to install a duplicate beside it. `id` resolves against the manifest's
     * origin, not against `start_url`, so this still matches what is already recorded.
     */
    id: '/explore',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: PALETTES.dark.field.canvas,
    /*
     * A manifest is one static file and cannot ask `prefers-color-scheme`, so unlike
     * `generateViewport()` it must commit to one. Dark, because a launch resolving out of dark
     * into light is a beat of paper and the reverse is a flash of white at dawn. Named as
     * `PALETTES.dark` rather than borrowed from `SCHEMES`, whose name reads mode-agnostic.
     */
    theme_color: PALETTES.dark.field.canvas,
    categories: ['navigation', 'travel', 'sports'],
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Same art, declared maskable — drawn inside the safe zone so a launcher can crop it to
      // any shape without taking a corner off the blaze.
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
