import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono, Source_Serif_4 } from 'next/font/google';
import { BRAND } from '@switchback/core/brand';
import { PALETTES } from '@switchback/ui';
import { currentTheme, modeAttribute } from '@/lib/theme';
import { RegisterServiceWorker } from '@/offline/register';
import { SyncQueuedWrites } from '@/offline/sync';
import { UnitsProvider } from '@/components/units';
import { TRPCReactProvider } from '@/trpc/react';
import { caller } from '@/trpc/server';
import './globals.css';

/**
 * Self-hosted at build time rather than requested from Google — no third-party connection
 * at runtime, and no layout shift.
 *
 * Archivo carries the width axis explicitly: `wght` comes with any variable font, `wdth`
 * has to be asked for, and without it `font-stretch: 78%` on the collar label silently
 * does nothing. That failure is invisible in a screenshot, which is why it is called out.
 */
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-archivo',
  display: 'swap',
});

/** Italic is loaded because the hydrography convention needs it, not for emphasis. */
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-source-serif',
  display: 'swap',
});

/** Coordinates, grid references, and section axis ticks. Two weights is all that needs. */
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
  applicationName: BRAND.name,
  /*
   * Launching from the home screen without the address bar, on two eras of iOS.
   *
   * Since iOS 17 Safari reads the manifest's `display` member, and the `standalone` in
   * `manifest.ts` is what actually does this on any current phone. Before 17 the manifest was
   * ignored and the launch keyed off a meta tag instead — and added to the home screen
   * without it, the site opens in a Safari tab with the address bar and toolbar taking a
   * third of the screen, which for a map is the difference between an app and a bookmark.
   *
   * `capable: true` used to emit that tag. It now emits the standardised
   * `mobile-web-app-capable`, which iOS 16 and earlier do not recognise, so the Apple-prefixed
   * name is set by hand below. Neither line costs anything; the hand-written one is the only
   * thing standing between an older phone and a bookmark.
   *
   * `title` is the label under the icon. Without it the launcher falls back to `<title>`,
   * which on the start URL reads "Explore · Switchback" and gets truncated to "Explore".
   *
   * No `statusBarStyle`. The only value with an effect is `black-translucent`, which pulls
   * the page up under the clock and the battery — and this page's top edge is the neatline
   * and the wordmark, not the map. `viewportFit: 'cover'` below is what the map needs, and
   * it does not require the status bar to be given away.
   */
  appleWebApp: { capable: true, title: BRAND.name },
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

/**
 * The colour behind the iOS status bar and the Android address bar.
 *
 * A function rather than a constant because it depends on the reader. When they have
 * chosen, there is one right answer and we give it. When they have not, we hand the browser
 * *both* answers keyed on `prefers-color-scheme` and let it pick — which is the same
 * decision `theme.css` makes for the page itself, made the same way, so the chrome and the
 * canvas cannot disagree at dusk.
 *
 * `field.canvas` in either case: the document below declares the field scheme outright, so
 * this is the colour immediately under the notch, not a guess at an average.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = await currentTheme();

  return {
    // The map is edge-to-edge on a phone and needs the notch area.
    viewportFit: 'cover',
    width: 'device-width',
    initialScale: 1,
    themeColor:
      theme === 'system'
        ? [
            { media: '(prefers-color-scheme: light)', color: PALETTES.light.field.canvas },
            { media: '(prefers-color-scheme: dark)', color: PALETTES.dark.field.canvas },
          ]
        : PALETTES[theme].field.canvas,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /*
   * Both reads are `cache()`d per request and every page below already does one of them, so
   * this costs a layout that was going to be dynamic anyway — the session is a cookie read,
   * and there is no version of "remember my theme" that can be answered at build time.
   */
  const [viewer, theme] = await Promise.all([caller.me.get(), currentTheme()]);

  /*
   * `sheet` is the token default — an unmarked page is a reading page. This app is not one:
   * the map is its ground, so the document declares `field` and reading views opt back out
   * on their own wrapper. Declaring it on <html> rather than on a div inside is what makes
   * the overscroll area, the scrollbar, and the address bar agree with the page.
   *
   * `data-mode` is the second axis and sits on the same element: scheme says *which sheet
   * this is*, mode says *which light you are reading it in*. Keeping them orthogonal is what
   * lets a reading page nested inside a dark document stay a reading page — it flips its own
   * scheme and inherits the mode, rather than having to know about four palettes.
   *
   * Absent when the reader follows their device, which is not the same as `data-mode="system"`:
   * the stylesheet's `prefers-color-scheme` fallbacks are keyed on `html:not([data-mode])`,
   * so writing the attribute at all would switch them off.
   */
  return (
    <html
      lang="en"
      data-scheme="field"
      data-mode={modeAttribute(theme)}
      className={`${archivo.variable} ${sourceSerif.variable} ${plexMono.variable}`}
    >
      <body>
        <TRPCReactProvider>
          {/*
           * Mounted here rather than per page because a measurement can be rendered by any
           * client component on any route, and the one thing this must not be is somewhere
           * a new card can forget to opt into.
           */}
          <UnitsProvider units={viewer?.units ?? 'metric'}>
            {children}
            {/* Inside the provider, not beside it: it posts with the tRPC client. */}
            <SyncQueuedWrites />
          </UnitsProvider>
        </TRPCReactProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
