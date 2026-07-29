'use client';

import { useEffect, useState } from 'react';
import { formatDistance } from '@switchback/core';
import type { UnitSystem } from '@switchback/core';
import type { FlyoverPlan } from '@switchback/geo';
import { prefersReducedMotion } from '../map/motion';
import { useUnitsOr } from '../units';

/**
 * Play the route.
 *
 * The bar under the button is the point of the control, not decoration on it. It fills with
 * *distance covered* while the film runs at a constant rate in *time*, so on a route with a
 * headwall in it the bar visibly stalls partway along — the camera is still moving, and the
 * ground is not going past. That is the same fact the elevation section states as a shape and
 * the stat block states as a number, said a third way, for free, by a rule that had to be
 * drawn anyway.
 *
 * Which is why it takes the contour plate. On this sheet contour means height, terrain, and
 * ground covered; a progress bar in ink would be structure, and a progress bar in survey
 * would mean the reader is in trouble.
 */

export interface FlyoverControlProps {
  /** Null when the route has no profile to fly — the control hides itself rather than fail. */
  plan: FlyoverPlan | null;
  playing: boolean;
  onToggle: (playing: boolean) => void;
  /** How far along the camera is, in metres. Null when nothing is flying. */
  distanceM: number | null;
  units?: UnitSystem;
}

export function FlyoverControl({
  plan,
  playing,
  onToggle,
  distanceM,
  units: given,
}: FlyoverControlProps) {
  const units = useUnitsOr(given);
  // Resolved after mount, never during render: the server has no media queries, and a button
  // whose label differs between the HTML and the first client render is a hydration error.
  const [still, setStill] = useState(false);
  useEffect(() => setStill(prefersReducedMotion()), []);

  if (!plan) return null;

  const covered = distanceM === null ? 0 : Math.min(1, Math.max(0, distanceM / plan.lengthM));
  const label = still ? (playing ? 'Flat view' : 'View in 3D') : playing ? 'Stop' : 'Fly the route';

  return (
    <div className="w-[168px] overflow-hidden rounded-panel border border-bezel bg-surface">
      <button
        type="button"
        onClick={() => onToggle(!playing)}
        className={`flex w-full items-center gap-sm px-md py-sm text-left transition-colors duration-quick ease-standard ${
          playing ? 'bg-ink text-canvas' : 'text-ink hover:bg-bezel/40'
        }`}
      >
        <Glyph playing={playing} still={still} />
        <span className="text-caption">{label}</span>
      </button>

      {/*
       * Present only while flying, and it does not animate itself — every frame of the film
       * sets a new width, so a CSS transition on top would be a second easing curve fighting
       * the first and the bar would lag the camera by its own duration.
       */}
      {playing && !still ? (
        <div className="border-t border-bezel px-md py-sm">
          <div className="h-[3px] w-full bg-bezel" aria-hidden>
            <div
              className="h-full bg-contour"
              style={{ width: `${(covered * 100).toFixed(2)}%` }}
            />
          </div>
          <div className="mt-hair flex justify-between font-mono text-micro text-ink-muted">
            <span>{formatDistance(distanceM ?? 0, units)}</span>
            <span>{formatDistance(plan.lengthM, units)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A triangle, a square, or a pair of contours.
 *
 * Drawn rather than set in a font because the third one has no glyph: for a reader who has
 * asked for less motion the button does not start a film, it tilts the sheet, and a play
 * triangle would be promising something that will not happen.
 */
function Glyph({ playing, still }: { playing: boolean; still: boolean }) {
  if (still) {
    return (
      <svg viewBox="0 0 12 12" className="h-[12px] w-[12px] shrink-0" aria-hidden>
        <path
          d="M1 8.5 L6 3 L11 8.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2.5 11 L6 7 L9.5 11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.5"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 12 12" className="h-[12px] w-[12px] shrink-0" aria-hidden>
      {playing ? (
        <rect x="2.5" y="2.5" width="7" height="7" fill="currentColor" />
      ) : (
        <path d="M3 1.5 L10.5 6 L3 10.5 Z" fill="currentColor" />
      )}
    </svg>
  );
}
