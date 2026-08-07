'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { TrailMapItem } from '@switchback/core';
import { liftCeiling } from './lift';
import { SelectedTrail } from './selected-trail';

export interface PickCardProps {
  trail: TrailMapItem;
  onDismiss: () => void;
  /** The map sheet. `--sb-card-lift` is written here, where MapLibre's corner chrome reads it. */
  pane: RefObject<HTMLElement | null>;
}

/**
 * The pick card, standing on MapLibre's bottom chrome, which steps up out of its way by the
 * card's own measured height — see `--sb-card-lift` in `explore.tsx`.
 *
 * The measurement is taken in a layout effect and written straight to the pane's style, so the
 * lift lands in the same frame the card first paints. Routed through React state and left to the
 * ResizeObserver's opening notification, it arrived a render later: in CI on software GL the card
 * covered the scale bar for 1.3 s, which is how the browser suite caught it (run 31078172785).
 * The observer stays for what happens afterwards — a title that rewraps, a pane that resizes.
 */
export function PickCard({ trail, onDismiss, pane }: PickCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const sheet = pane.current;
    const card = cardRef.current;
    if (!sheet || !card) return;

    const measure = () => {
      const box = sheet.getBoundingClientRect();
      const room = box.bottom - card.getBoundingClientRect().top;
      const lift = Math.min(Math.max(0, Math.round(room)), liftCeiling(box.height));
      sheet.style.setProperty('--sb-card-lift', `${String(lift)}px`);
    };

    measure();
    // The card's own height is the usual reason to re-measure, but the ceiling is a fraction of
    // the pane, so a pane that changes height moves it — both are watched.
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    observer.observe(sheet);
    return () => {
      observer.disconnect();
      sheet.style.removeProperty('--sb-card-lift');
    };
    // Re-measured on a change of trail as well as on mount: a different title wraps to a
    // different height, and waiting for the observer to say so is the defect above.
  }, [pane, trail.id]);

  return (
    // Bottom-left, clear of the layer switcher at top-right.
    <div
      ref={cardRef}
      className="clear-home-indicator pointer-events-none absolute bottom-xl left-lg right-lg flex md:right-auto"
    >
      <SelectedTrail trail={trail} onDismiss={onDismiss} />
    </div>
  );
}
