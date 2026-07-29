'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * A photograph, and what stands in its place when there isn't one.
 *
 * **A photograph we never had and a photograph that failed to arrive are the same thing to a
 * reader**, so this treats them as one state. Everywhere photographs appear here the markup
 * used to be `url ? <img> : <fallback>`, which handles only the first: when the URL is present
 * but the file is gone, the browser draws its own broken-image glyph — a torn page and the alt
 * text, in the browser's default styling — inside a 72 px slot that was composed down to the
 * hairline. That is the one place the product's surface leaks the user agent's.
 *
 * It is not a hypothetical. Almost none of these URLs are ours and none are permanent:
 * Commons files get deleted while our cache still holds the link for up to thirty days,
 * Mapillary serves from a CDN that rotates, an R2 object can outlive or predecease its row
 * when an upload is interrupted, and an avatar belongs to whichever identity provider signed
 * the hiker in and changes when they change it.
 *
 * **A plain `<img>`, not `next/image`** — the reason is the same at every call site, which is
 * why it is written once here. The hosts are not knowable at build time, and widening
 * `images.remotePatterns` far enough to cover them would turn our own domain into an open
 * image proxy for any URL the ingest pipeline happened to pick up.
 */

interface PhotographProps {
  /** `null` when there is no photograph — the fallback renders, same as a failed load. */
  src: string | null | undefined;
  /** Empty for decorative thumbnails beside a name that already says what they show. */
  alt: string;
  className?: string;
  /** Carries the BlurHash wash on call sites that have one. */
  style?: CSSProperties;
  loading?: 'lazy' | 'eager';
  width?: number;
  height?: number;
  /**
   * What the slot holds instead. Nothing by default, which is right where the photograph is
   * an ornament to something else; where it *is* the content, pass a real one.
   */
  fallback?: ReactNode;
}

export function Photograph({
  src,
  alt,
  className,
  style,
  loading,
  width,
  height,
  fallback = null,
}: PhotographProps) {
  /*
   * Which URL failed, rather than whether one did. Both lightboxes step through a set of
   * photographs on a single element, and a boolean would strand every later frame behind one
   * dead file. Storing the URL means the state answers for that URL alone and corrects itself
   * when a different one arrives — no effect, no reset, no `key` to remember.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const settle = useCallback(
    (node: HTMLImageElement | null) => {
      /*
       * A 404 usually resolves long before the JS bundle does, so the error event can fire
       * while there is no React handler attached to hear it, and React does not replay it on
       * hydration. An image that reports itself complete with no natural width is one that
       * finished by failing; asking the element directly is the only way to learn it after
       * the fact. On a load still in flight `complete` is false and `onError` below has it.
       */
      if (node?.complete && node.naturalWidth === 0 && src) setFailedSrc(src);
    },
    [src],
  );

  if (!src || failedSrc === src) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={settle}
      src={src}
      alt={alt}
      className={className}
      style={style}
      loading={loading}
      width={width}
      height={height}
      onError={() => setFailedSrc(src)}
    />
  );
}

/**
 * The slot a photograph was going to fill, still holding its place.
 *
 * For strips and rows, where the picture is an ornament to something else and the something
 * else is still there. Rendering nothing would pull the caption, the credit and the licence up
 * under a void and close the gap the eye uses to tell one frame from the next, so the plate
 * keeps the measure. Dashed rather than solid, and the same device the empty-list card uses:
 * a ruled space on the sheet, which is what this is.
 *
 * Takes its size from the call site, so it is exactly as big as the photograph would have been.
 */
export function PhotographMissing({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      // Not a styling hook: the plate is `aria-hidden` and has no text, so a data attribute is
      // the only handle the browser suite has on "the photograph did not arrive".
      data-photograph="missing"
      className={`block rounded-hair border border-dashed border-bezel bg-bezel/20 ${className ?? ''}`}
    />
  );
}

/**
 * A photograph that failed where the photograph was the point.
 *
 * Only for the lightboxes. Somebody opened a dialog to look at one specific picture, and a
 * silent plate there is a dead end with no explanation. This says which of the two things went
 * wrong — the file, not their connection — without claiming more certainty than we have, and
 * without apologising for a Commons deletion we do not control.
 */
export function PhotographUnavailable() {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-sm border-b border-bezel px-md py-3xl text-center">
      <p className="font-mono text-micro uppercase tracking-wide text-ink-muted">No photograph</p>
      <p className="max-w-measure font-text text-body text-ink-muted">
        This one didn’t load. It may have been removed where it was published.
      </p>
    </div>
  );
}
