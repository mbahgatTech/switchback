import type { MetadataRoute } from 'next';
import { BRAND } from '@switchback/core/brand';
import { SCHEMES } from '@switchback/ui';

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
    start_url: '/explore',
    // Where a cold launch lands. `/explore` rather than `/`, because somebody who has put
    // this on their home screen has already read the front page.
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: SCHEMES.field.canvas,
    // Matches the `themeColor` in the root layout, which declares the field scheme outright.
    theme_color: SCHEMES.field.canvas,
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
