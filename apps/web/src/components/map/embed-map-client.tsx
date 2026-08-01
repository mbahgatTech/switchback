'use client';

import dynamic from 'next/dynamic';
import type { EmbedMapProps } from './embed-map';

/**
 * The `ssr: false` boundary. MapLibre reaches for `window` while its module evaluates, and
 * `dynamic(…, { ssr: false })` is only legal inside a client component in Next 16 — so this
 * file exists to be that boundary and keep the page above it a server component.
 */

const EmbedMap = dynamic(() => import('./embed-map').then((mod) => mod.EmbedMap), {
  ssr: false,
  // Canvas, not a spinner: a flash of loading chrome inside a `WebView` reads as the app
  // itself being slow.
  loading: () => <div className="h-dvh w-full bg-canvas" />,
});

export function EmbedMapClient(props: EmbedMapProps) {
  return <EmbedMap {...props} />;
}
