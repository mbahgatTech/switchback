'use client';

import { useCallback, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * A photograph, and what stands in its place when there isn't one. A photograph we never had
 * and one that failed to arrive are the same thing to a reader, so this is one state — without
 * it, a present URL with a missing file draws the browser's own broken-image glyph.
 *
 * A plain `<img>`, not `next/image`: the hosts are not knowable at build time, and widening
 * `images.remotePatterns` far enough to cover them would make our domain an open image proxy.
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
   * Which URL failed, rather than whether one did. Both lightboxes step through a set on a
   * single element, and a boolean would strand every later frame behind one dead file.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const settle = useCallback(
    (node: HTMLImageElement | null) => {
      /*
       * A 404 usually resolves before the JS bundle does, so the error event can fire with no
       * React handler attached, and React does not replay it on hydration. An element that
       * reports itself complete with no natural width finished by failing.
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
 * The slot a photograph was going to fill, still holding its place. For strips and rows, where
 * rendering nothing would pull the caption and credit up under a void. Takes its size from the
 * call site, so it is exactly as big as the photograph would have been.
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
 * A photograph that failed where the photograph was the point — the lightboxes only. Says which
 * of the two things went wrong, the file rather than their connection.
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
