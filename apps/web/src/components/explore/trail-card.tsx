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
import { Mark } from '../lists/marks';
import { SaveMark, useSaved } from '../lists/save-mark';
import { Photograph } from '../photos/photograph';
import { useUnits } from '../units';
import { ROUTE_LABEL } from './route-label';

/**
 * One entry in the index.
 *
 * **Picking an entry frames it on the sheet. It does not leave the page.** The index and the
 * map are two views of one set, and the whole reason to put them side by side is that you can
 * move through the set without losing the view you built to find it — the pan, the zoom, the
 * filters, the other nine results. A card that navigated on click spent all of that on a
 * single click, and the way back was the browser's back button. So the card is a frame
 * control, and going to the trail is a second, named decision: `Open`, in the corner, and
 * again on the card that appears over the map once something is picked.
 *
 * **Why the frame control is an invisible overlay and not the heading.** The click target is
 * the whole card, which is far more than a heading — so the heading stays a heading, and an
 * absolutely-positioned button covers the card and carries the accessible name "Show X on
 * the map". A positioned element paints over its non-positioned siblings whatever the source
 * order, so the overlay comes first in the DOM and still sits on top; the corner controls
 * lift back above it with `z-10` because they go somewhere else entirely.
 *
 * **`Open` is always drawn.** Its predecessor appeared on `:hover`, which is a state a
 * touchscreen does not have — the control was simply unreachable on a phone. It is quiet
 * rather than hidden.
 */

export interface TrailCardProps {
  trail: TrailMapItem;
  selected: boolean;
  hovered: boolean;
  /** Null when signed out. Decided on the server so no mark flickers in after hydration. */
  viewerId: string | null;
  onHover: (trailId: string | null) => void;
  onSelect: (trailId: string) => void;
}

/** The plate a difficulty prints on, as a Tailwind background utility. */
const PLATE_BG = {
  woodland: 'bg-woodland',
  contour: 'bg-contour',
  survey: 'bg-survey',
} as const;

export function TrailCard({
  trail,
  selected,
  hovered,
  viewerId,
  onHover,
  onSelect,
}: TrailCardProps) {
  const { stats } = trail;
  const units = useUnits();
  const plate = PLATE_BG[DIFFICULTY_PLATE[trail.difficulty]];
  const saved = useSaved(viewerId);
  const ringed = saved.favorites.includes(trail.id);
  const hiked = saved.completed.includes(trail.id);
  // One string for the heading and for all four accessible names on this card. A card whose
  // "Open X" differs from the heading beside it reads as two trails in a screen reader.
  const title = trailTitle(trail);

  return (
    // The id is on the list item so the index can scroll to whatever the map selected.
    <li data-trail-id={trail.id}>
      <article
        onMouseEnter={() => onHover(trail.id)}
        onMouseLeave={() => onHover(null)}
        className={[
          'group relative flex gap-md rounded-hair border p-md transition-colors duration-quick ease-standard',
          selected
            ? 'border-ink bg-surface'
            : hovered
              ? 'border-ink-muted bg-surface/60'
              : 'border-bezel bg-transparent',
        ].join(' ')}
      >
        {/*
         * The card, as a control. `aria-current` rather than `aria-pressed`: this is the
         * entry the map is currently showing, which is a position in a set, not a switch —
         * and picking another one moves the mark rather than turning this one off.
         */}
        <button
          type="button"
          onClick={() => onSelect(trail.id)}
          onFocus={() => onHover(trail.id)}
          onBlur={() => onHover(null)}
          aria-label={`Show ${title} on the map`}
          aria-current={selected ? 'true' : undefined}
          className="absolute inset-0 rounded-hair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        />

        <Photograph
          src={trail.primaryPhotoUrl}
          alt=""
          loading="lazy"
          className="h-[72px] w-[72px] shrink-0 rounded-hair object-cover"
          fallback={
            // No photo yet is the common case on a freshly ingested tile — and a Commons file
            // deleted since we cached its URL lands here too, which is right: both are a row
            // with no picture behind it. Rather than a grey box, the tile carries the one
            // number that tells you what kind of hike this is before you open it.
            <div
              aria-hidden
              className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-hair border border-bezel bg-bezel/30 font-mono text-micro text-ink-muted"
            >
              {formatElevation(stats.maxEleM, units)}
            </div>
          }
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-sm">
            {/* A destination title is roughly twice the OSM name it stands in for, so this
                heading has to give way rather than shove. `min-w-0` lets it shrink past its
                longest word, which is what keeps `Open` and the mark on screen; `wrap-break-word`
                then wraps that word instead of letting it be clipped mid-syllable. Both are
                needed, and so is `min-w-0` on the column in `explore.tsx` — measured at 375 px. */}
            <h3 className="min-w-0 wrap-break-word text-body font-medium leading-tight text-ink">
              {title}
            </h3>

            {/* `gap-md`, and the 12 px is measured rather than chosen. The mark beside this
                link is 24 px of ring with an invisible 48 px target centred on it, so its
                target reaches exactly 12 px past the ring on each side — at `gap-xs` that
                box lay over a third of "Open", and because the mark is positioned and the
                link is not, it would have taken those taps whatever the source order said.
                At `gap-md` the two targets meet and neither crosses. */}
            <div className="relative z-10 flex shrink-0 items-center gap-md">
              <Link
                href={`/trails/${trail.slug}`}
                // `min-h-6` rather than a rung off `HEIGHT`, for the same reason the theme
                // control takes it: this is collar-register text made pressable, and 24 px
                // is the floor WCAG 2.5.8 puts under a target that is not inline prose. It
                // costs no density here — the row was already 24 px tall because of the mark.
                className="inline-flex min-h-6 items-center rounded-hair px-xs font-mono text-micro uppercase text-ink-muted transition-colors duration-quick ease-standard hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {/* Named once for the eye and once for the ear: a column of links all called
                    "Open" is unusable in a screen reader's link list. */}
                <span className="sr-only">Open {title}</span>
                <span aria-hidden>Open</span>
              </Link>
              <SaveMark trailId={trail.id} trailName={title} ringed={ringed} viewerId={viewerId} />
            </div>
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
            {hiked ? (
              // Not a control — a fact that changes how the rest of the card is read. Someone
              // scanning for somewhere new needs "been here" answered before the statistics.
              <div className="flex items-center gap-xs text-ink">
                <Mark shape="tick" size={11} />
                <dt className="sr-only">Hiked</dt>
                <dd>Hiked</dd>
              </div>
            ) : null}
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
      </article>
    </li>
  );
}

/**
 * A statistic reads as its value, not as "Length 8.2 km" — the label is for a screen
 * reader and for the eye scanning a column, and the unit already says which is which.
 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-xs">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
