import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono, Source_Serif_4 } from 'next/font/google';
import { BRAND } from '@switchback/core/brand';
import { PALETTES } from '@switchback/ui';
import { currentTheme, modeAttribute } from '@/lib/theme';
import { ReaderIdentity } from '@/offline/reader';
import { RegisterServiceWorker } from '@/offline/register';
import { SyncQueuedWrites } from '@/offline/sync';
import { UnitsProvider } from '@/components/units';
import { TRPCReactProvider } from '@/trpc/react';
import { caller } from '@/trpc/server';
import './globals.css';

/**
 * Self-hosted at build time — no third-party connection at runtime, and no layout shift.
 * `axes: ['wdth']` is required: without it `font-stretch: 78%` on the collar label silently
 * does nothing, and that failure is invisible in a screenshot.
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
   * Launching from the home screen without the address bar. `capable: true` now emits the
   * standardised `mobile-web-app-capable`, which iOS 16 and earlier do not recognise — so the
   * Apple-prefixed name below is written by hand and is not a duplicate. `title` is the label
   * under the icon; without it the launcher falls back to `<title>` and can truncate. No
   * `statusBarStyle`: the only value with an effect pulls the page under the clock.
   */
  appleWebApp: { capable: true, title: BRAND.name },
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

/**
 * The colour behind the iOS status bar and the Android address bar. A function because it
 * depends on the reader: with no choice made, the browser gets both answers keyed on
 * `prefers-color-scheme`, the same way `theme.css` decides it for the page.
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
  // Both reads are `cache()`d per request and every page below already does one of them.
  const [viewer, theme] = await Promise.all([caller.me.get(), currentTheme()]);

  /*
   * `sheet` is the token default; this app's ground is the map, so the document declares `field`
   * and reading views opt back out on their own wrapper. On <html> rather than an inner div so
   * the overscroll area, the scrollbar and the address bar agree with the page.
   *
   * `data-mode` is the orthogonal axis and is *absent* when the reader follows their device —
   * not `"system"`. The stylesheet's `prefers-color-scheme` fallbacks key on
   * `html:not([data-mode])`, so writing the attribute at all switches them off.
   */
  return (
    <html
      lang="en"
      data-scheme="field"
      data-mode={modeAttribute(theme)}
      className={`${archivo.variable} ${sourceSerif.variable} ${plexMono.variable}`}
    >
      <body>
        {/*
         * Before the provider and before the queue, because it is what tells the queue whose
         * rows are whose — a browser that has changed hands sets aside the previous person's
         * unsent hikes rather than posting them under whoever is signed in now.
         */}
        <ReaderIdentity readerId={viewer?.id ?? null} />
        <TRPCReactProvider>
          {/* Mounted here, not per page: any client component on any route may render a measurement. */}
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
