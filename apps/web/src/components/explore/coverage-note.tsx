'use client';

import type { AreaSummary, TileCoverage } from '@switchback/core';

/**
 * What we hold for the box you are looking at.
 *
 * This is the visible half of the on-demand design, and it exists because the honest answer
 * to "why is this map empty" is *we have not fetched this ground yet*, not a spinner. The
 * state is carried in words rather than in a spinner or a pulse: `prefers-reduced-motion`
 * flattens every animation in this app to nothing, and a status that only exists as motion
 * would then not exist at all.
 */

export interface CoverageNoteProps {
  coverage: TileCoverage | undefined;
  /** The wide-view survey, when there is one. Null at every ordinary zoom. */
  area: AreaSummary | null | undefined;
  loading: boolean;
  /** Results currently drawn, so the note can say what it is qualifying. */
  shown: number;
  total: number;
}

export function CoverageNote({ coverage, area, loading, shown, total }: CoverageNoteProps) {
  const message = describe(coverage, area, loading, shown, total);

  return (
    <p
      // Tiles land seconds after the viewport settles, and the count changes under the
      // reader. Polite, so it is announced at a pause rather than interrupting.
      aria-live="polite"
      // Not a `.collar`. Every other collar on the sheet is a two-word label — SORT, FILTERS,
      // DIFFICULTY — and uppercase at 0.14em is exactly right for those and wrong for this,
      // which is a running sentence with numbers in it. It sat in the collar's slot in the
      // layout and so inherited the collar's class, then cancelled two thirds of it back off
      // again; what it actually wants is the collar's *size*, in the page's own voice.
      className="flex items-center gap-sm text-micro tracking-normal text-ink-muted"
    >
      {message.pending ? (
        <span
          aria-hidden
          className="h-[6px] w-[6px] shrink-0 rounded-full bg-contour motion-safe:animate-pulse"
        />
      ) : null}
      <span className="min-w-0">{message.text}</span>
    </p>
  );
}

function describe(
  coverage: TileCoverage | undefined,
  area: AreaSummary | null | undefined,
  loading: boolean,
  shown: number,
  total: number,
): { text: string; pending: boolean } {
  if (coverage?.tooLarge) {
    /*
     * Wide views serve whatever ground is already cached — the ceiling bounds fetching, not
     * reading. So the note qualifies the count rather than replacing it: what is on screen
     * is real, it is just not a promise of completeness.
     *
     * What it no longer says is "zoom in". That was the only instruction available when a
     * wide view had no way to request anything, and it was a strange thing to tell somebody
     * who had deliberately zoomed out to compare regions. There is a button on the sheet
     * now, so the note's job here is to report the survey behind it — how much of this view
     * we hold, and whether anything is moving — and let the button do the asking.
     */
    if (area && area.working > 0) {
      return {
        text: `${count(shown, total)} · fetching this area, ${area.fresh} of ${area.tiles} ${plural(area.tiles, 'tile')} in`,
        pending: true,
      };
    }
    if (area && area.outstanding > 0) {
      return {
        text:
          shown > 0
            ? `${count(shown, total)} already mapped here · ${area.outstanding} ${plural(area.outstanding, 'tile')} of this view unfetched`
            : `Nothing cached this wide — ${area.outstanding} ${plural(area.outstanding, 'tile')} to fetch from OpenStreetMap`,
        pending: false,
      };
    }
    return {
      text: shown > 0 ? `${count(shown, total)} · this view fully fetched` : 'No trails here.',
      pending: false,
    };
  }

  if (loading && !coverage) return { text: 'Reading the sheet…', pending: true };

  const pending = coverage?.pendingTiles.length ?? 0;
  if (pending > 0) {
    return {
      text:
        shown > 0
          ? `${count(shown, total)} · fetching ${pending} more ${plural(pending, 'tile')} from OpenStreetMap`
          : `Fetching ${pending} ${plural(pending, 'tile')} from OpenStreetMap — trails appear as they land`,
      pending: true,
    };
  }

  const refreshing = coverage?.refreshingTiles.length ?? 0;
  if (refreshing > 0) {
    return { text: `${count(shown, total)} · refreshing cached ground`, pending: true };
  }

  if (shown === 0) {
    return { text: 'No trails here. Try widening the filters or panning.', pending: false };
  }

  return { text: count(shown, total), pending: false };
}

/** "120 of 340 trails" — but never "120 of 120 trails", which reads as a truncation. */
function count(shown: number, total: number): string {
  if (total > shown) return `${shown} of ${total} trails`;
  return `${shown} ${plural(shown, 'trail')}`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
