'use client';

import Link from 'next/link';
import type { TrailMapItem } from '@switchback/core';
import {
  DIFFICULTY_LABELS,
  formatDistance,
  formatDuration,
  formatElevation,
  trailTitle,
} from '@switchback/core';
import { DIFFICULTY_PLATE } from '@switchback/ui';
import { BUTTON, HEIGHT, PRIMARY } from '../controls';
import { Photograph } from '../photos/photograph';
import { useUnits } from '../units';
import { ROUTE_LABEL } from './route-label';

/**
 * The card that appears when a line on the sheet is picked.
 *
 * Clicking a trail on a map has to answer two questions at once, and answering only the
 * first is the failure mode: *which one is that* — resolved by the map itself, which has
 * already framed and thickened the line — and *do I want it*. Without the second, a click
 * highlights a squiggle and leaves the user to hunt the same trail down in the list to find
 * out anything about it. So the pick puts the trail's own figures directly under the
 * cursor, with one obvious way onward.
 *
 * It sits **over** the map rather than in the collar beside it. The collar is an index: a
 * scrolled list where the selected entry may well be off-screen, and scrolling to it would
 * move the very thing the user is reading. A card pinned to the sheet stays where the click
 * happened, which is where the eye already is.
 *
 * **On the accent rule.** Woodland, the trail plate, and only ever woodland — the same
 * green the line is drawn in, so the card reads as belonging to the thing that is now lit
 * up on the map. Not the difficulty colour: that would put the survey plate on a third of
 * all cards, and red in this system means the user and their safety, never a rating.
 */

export interface SelectedTrailProps {
  trail: TrailMapItem;
  onDismiss: () => void;
}

const PLATE_BG = {
  woodland: 'bg-woodland',
  contour: 'bg-contour',
  survey: 'bg-survey',
} as const;

export function SelectedTrail({ trail, onDismiss }: SelectedTrailProps) {
  const { stats } = trail;
  const units = useUnits();
  const plate = PLATE_BG[DIFFICULTY_PLATE[trail.difficulty]];

  return (
    <aside
      // Re-announced on every pick: the heading changes but the region does not, so without
      // this a screen-reader user gets nothing when they arrow onto a different line.
      aria-live="polite"
      aria-label="Selected trail"
      className="pointer-events-auto w-full max-w-[26rem] overflow-hidden rounded-panel border border-bezel bg-surface"
    >
      <div aria-hidden className="h-[3px] w-full bg-woodland" />

      <div className="flex gap-md p-md">
        {/*
         * No fallback: on a card this small, beside a name and four figures that already say
         * what the trail is, a stand-in for a missing photograph would be a box drawn to
         * announce an absence. The card simply closes up.
         */}
        <Photograph
          src={trail.primaryPhotoUrl}
          alt=""
          className="h-[84px] w-[84px] shrink-0 rounded-hair object-cover"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-sm">
            {/* Shrinks and wraps rather than pushing `Close` off the card — see the same pair
                on the index card in `trail-card.tsx`. */}
            <h2 className="min-w-0 wrap-break-word text-body font-medium leading-tight text-ink">
              {trailTitle(trail)}
            </h2>
            {/*
             * The hit area is the whole touch rung; the word is what you see of it. It used
             * to be an 15 px strip of text — fine with a mouse, a coin-toss with a thumb,
             * and this card exists to be poked at on a phone. The negative margins let the
             * box overhang into the card's own padding so the word still lines up with the
             * heading beside it. No focus utilities: `globals.css` gives every focusable
             * thing the same ring, and restating it here is how two rings drift apart.
             */}
            <button
              type="button"
              onClick={onDismiss}
              className={`collar ${HEIGHT.touch} -mr-sm -mt-sm inline-flex shrink-0 items-center rounded-hair px-sm hover:text-ink`}
            >
              <span className="sr-only">Clear selection</span>
              <span aria-hidden>Close</span>
            </button>
          </div>

          {trail.regionName ? (
            <p className="mt-hair truncate text-caption text-ink-muted">{trail.regionName}</p>
          ) : null}

          <dl className="mt-sm flex flex-wrap items-baseline gap-x-md gap-y-xs font-mono text-micro text-ink-muted">
            <Stat label="Length" value={formatDistance(stats.lengthM, units)} />
            <Stat label="Gain" value={`↑${formatElevation(stats.gainM, units)}`} />
            <Stat label="Time" value={formatDuration(stats.estimatedTimeS)} />
            <Stat label="Route" value={ROUTE_LABEL[trail.routeType]} />
            <div className="flex items-center gap-xs">
              <span aria-hidden className={`h-[6px] w-[6px] rounded-full ${plate}`} />
              <dt className="sr-only">Difficulty</dt>
              <dd>{DIFFICULTY_LABELS[trail.difficulty]}</dd>
            </div>
            {trail.rating !== null ? (
              <div className="flex items-baseline gap-xs">
                <dt className="sr-only">Rating</dt>
                <dd>
                  {trail.rating.toFixed(1)}
                  <span className="text-ink-muted"> · {trail.reviewCount}</span>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </div>

      <div className="border-t border-bezel p-md pt-sm">
        <Link
          href={`/trails/${trail.slug}`}
          // Named for the destination, not the gesture. "See more" and "Details" both
          // describe the click; this describes where you land, which is the only part the
          // user is deciding about.
          className={`${BUTTON} ${PRIMARY} ${HEIGHT.touch} w-full px-md text-body`}
        >
          Open trail
        </Link>
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-xs">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
