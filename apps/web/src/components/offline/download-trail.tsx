'use client';

/**
 * Take this trail with you.
 *
 * One control, in the row under the trail's name beside the list marks and Record — because
 * the decision it serves is made at the same moment as those: standing in a car park with
 * one bar, about to lose it. It has to say what it will cost before it costs it, and it has
 * to be honest about what "offline" means afterwards.
 *
 * The progress readout is the contour plate. Contour is elevation and distance covered
 * everywhere else in this product, and a download is a distance being covered — the rule
 * holds rather than being bent to fit a fifth colour in.
 */

import { formatBytes } from '@switchback/core';
import type { TrailDetail } from '@switchback/core';
import { useTrailDownload } from '@/offline/use-offline';
import type { DownloadPhase } from '@/offline/download';
import { HEIGHT } from '../controls';

const CONTROL = `collar inline-flex ${HEIGHT.touch} items-center gap-sm rounded-hair border px-md transition-colors duration-quick ease-standard`;

/** What the hiker is waiting on, in words rather than a spinner. */
const PHASE_LABEL: Record<DownloadPhase, string> = {
  planning: 'Working out the map',
  page: 'Saving the trail',
  tiles: 'Saving the map',
  media: 'Saving photographs',
  saving: 'Finishing',
};

export function DownloadTrail({ trail }: { trail: TrailDetail }) {
  const { state, start, cancel, remove } = useTrailDownload(trail);

  if (state.status === 'checking') {
    // Reserve the space rather than popping a button in a beat later, next to two controls
    // somebody may already be reaching for.
    return <span className={`${CONTROL} border-bezel text-ink-muted`}>Offline</span>;
  }

  if (state.status === 'downloading') {
    const { progress } = state;
    const fraction = progress.total > 0 ? Math.min(progress.done / progress.total, 1) : 0;

    return (
      <span className={`${CONTROL} relative overflow-hidden border-contour text-ink`}>
        {/*
         * The fill sits behind the text rather than beside it as a separate bar. A download
         * has one thing to say — how much of it is done — and saying it as the shape of the
         * control itself costs no extra row in a layout that is already three controls wide.
         */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-contour/15 transition-[width] duration-quick ease-standard"
          style={{ width: `${(fraction * 100).toFixed(1)}%` }}
        />
        <span className="relative" aria-live="polite">
          {PHASE_LABEL[progress.phase]} · {Math.round(fraction * 100)}%
        </span>
        <button
          type="button"
          onClick={cancel}
          className="relative rounded-hair text-ink-muted underline decoration-dotted underline-offset-4 hover:text-survey"
        >
          Stop
        </button>
      </span>
    );
  }

  if (state.status === 'ready') {
    const { row } = state;
    return (
      <span className={`${CONTROL} border-woodland text-ink`}>
        <span>
          Offline · {formatBytes(row.bytes)}
          {/*
           * A capped download is said out loud. "Offline" that quietly means "offline until
           * you zoom in past the ridge" is the failure this whole feature exists to prevent.
           */}
          {row.truncated ? ` · sharp to z${row.coveredMaxZoom}` : ''}
        </span>
        <button
          type="button"
          onClick={remove}
          className="rounded-hair text-ink-muted underline decoration-dotted underline-offset-4 hover:text-survey"
        >
          Remove
        </button>
      </span>
    );
  }

  if (state.status === 'failed') {
    return (
      <span className={`${CONTROL} border-survey text-survey`} role="status">
        {state.message}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      className={`${CONTROL} border-bezel text-ink-muted hover:border-ink-muted hover:text-ink`}
    >
      {/* The size is an estimate and is written as one; the alternative is a promise we cannot keep. */}
      Take offline · ~{formatBytes(state.estimatedBytes)}
    </button>
  );
}
