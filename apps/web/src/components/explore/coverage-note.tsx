'use client';

import type { AreaSummary, TileCoverage } from '@switchback/core';

/**
 * What we hold for the box you are looking at — the visible half of the on-demand design. The
 * state is carried in words rather than in a spinner: `prefers-reduced-motion` flattens every
 * animation here, and a status that only exists as motion would then not exist at all.
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
      // Not a `.collar`. Every other collar on the sheet is a two-word label, and uppercase at
      // 0.14em is wrong for a running sentence with numbers in it; what this wants is the
      // collar's *size*, in the page's own voice.
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
     * reading. So the note qualifies the count rather than replacing it: what is on screen is
     * real, it is just not a promise of completeness. The button on the sheet does the asking.
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

  /*
   * Ingest was refused — the queue is deep, or the database is close to full. Said plainly,
   * with a time to come back, because the same state shown as a pending count describes tiles
   * that were never queued as arriving, forever.
   */
  if (coverage?.busy) {
    /*
     * Which refusal decides the second half of the sentence, because none of them share an
     * instruction: a deep queue drains on its own, a full database needs somebody to decide
     * what to delete, and a spent allowance is this reader's own and says nothing about the
     * product. `'queue-depth'` means only the 600-job request queue, which does drain in
     * minutes — the derived backlog no longer refuses anything, see `DERIVED_QUEUE_WARN_DEPTH`
     * in `backpressure.ts`. A new reason needs a new sentence.
     */
    const why =
      coverage.busyReason === 'storage'
        ? 'fetching new ground is paused: there is no room left to store it. Everything already mapped still works.'
        : coverage.busyReason === 'rate-limit'
          ? 'that is a lot of new ground at once, so fetching more is paused for now. Everything already mapped still works.'
          : 'fetching new ground is paused while the queue clears. Try again in a few minutes.';
    return {
      text: shown > 0 ? `${count(shown, total)} · ${why}` : capitalise(why),
      pending: false,
    };
  }

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

/** The same clause, used mid-sentence after a count or on its own at the start of one. */
function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** "120 of 340 trails" — but never "120 of 120 trails", which reads as a truncation. */
function count(shown: number, total: number): string {
  if (total > shown) return `${shown} of ${total} trails`;
  return `${shown} ${plural(shown, 'trail')}`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
