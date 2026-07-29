'use client';

import dynamic from 'next/dynamic';
import type { EmbedMapProps } from './embed-map';

/**
 * The `ssr: false` boundary.
 *
 * MapLibre reaches for `window` while its module is still evaluating, so it cannot be part
 * of a server render at all — and `dynamic(…, { ssr: false })` is itself only legal inside a
 * client component in Next 16. This file exists to be that client component and nothing
 * else; the page above it stays a server component so it can read its search params the
 * ordinary way. Same shape as `explore.tsx`, for the same reason.
 */

const EmbedMap = dynamic(() => import('./embed-map').then((mod) => mod.EmbedMap), {
  ssr: false,
  // Canvas, not a spinner. This is replaced within a frame or two of hydration, and a
  // flash of loading chrome inside a `WebView` reads as the app itself being slow.
  loading: () => <div className="h-dvh w-full bg-canvas" />,
});

export function EmbedMapClient(props: EmbedMapProps) {
  return <EmbedMap {...props} />;
}
