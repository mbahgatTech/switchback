'use client';

import { useMutation } from '@tanstack/react-query';
import type { AreaSummary, BBox } from '@switchback/core';
import { useTRPC } from '@/trpc/react';
import { BUTTON, HEIGHT, SECONDARY } from '../controls';

/**
 * Fetch this area — the one control that asks the pipeline for ground it has never seen.
 *
 * Everywhere else on this map, ingest is automatic: the viewport settles, the tiles under it
 * are queued, and the trails arrive. That path caps at twelve z9 tiles, which is right —
 * nobody panning a map is asking to fetch a continent, and a product that queued three
 * hundred Overpass queries because a viewport got wide would punish the act of zooming out.
 *
 * But zoomed out is the view you use to *decide where to go*, and until now it was the one
 * view with no way to say "yes, actually, fetch this". So this button appears exactly there
 * and nowhere else: past the ceiling, with ground still outstanding. At every ordinary zoom
 * it does not exist, because the map is already filling itself and a button offering to do
 * what is already happening is noise.
 *
 * **On the copy.** "Fetch this area", not AllTrails' "Search this area". Searching is what
 * already happened — the query ran, the index answered, and what came back is on screen.
 * What is missing is upstream data, and *fetch* is the word the coverage note beside it
 * already uses for that. One vocabulary for one idea.
 *
 * **On the progress.** Tiles, not a time estimate. An Overpass round trip is anywhere from
 * two seconds to a timeout-and-retry on a busy mirror, so any minutes figure would be a
 * guess presented as a fact; "18 of 96 tiles" is measured, monotonic, and visibly moving,
 * which is what a progress indicator is for.
 *
 * **On the fill.** This is the house button (`BUTTON` + `SECONDARY`) with `bg-surface` added,
 * and the fill is the only thing that differs from the same button in a panel. It used to be
 * a `.dial` — transparent, with a dotted underline — which is right for a value inside a
 * sentence and wrong for the only control floating over satellite imagery: over anything
 * darker than pale scree it was an unreadable word with no edges. Everything over the map is
 * opaque.
 */

export interface FetchAreaProps {
  area: AreaSummary | null | undefined;
  bbox: BBox | null;
  /** Fired after a successful request so the caller can start polling immediately. */
  onRequested: () => void;
}

export function FetchArea({ area, bbox, onRequested }: FetchAreaProps) {
  const trpc = useTRPC();
  const fetchArea = useMutation(
    trpc.trails.fetchArea.mutationOptions({
      onSuccess: onRequested,
    }),
  );

  // No area survey means the viewport is inside the automatic ceiling, and nothing here has
  // a job to do. Nothing outstanding means the ground is already ours.
  if (!area || !bbox || area.outstanding === 0) return null;

  const working = area.working;
  const done = area.fresh;
  const busy = fetchArea.data?.busy ?? false;
  const busyReason = fetchArea.data?.busyReason ?? null;

  /*
   * Percentage of the *capped* set, which is the set this press can actually finish. Using
   * `requiredTiles` would show a bar that stops at 12% on a continental view and never
   * moves — technically the fraction of the box covered, and useless as a signal that the
   * thing you pressed is working.
   */
  const percent = area.tiles > 0 ? Math.round((done / area.tiles) * 100) : 0;

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-xs">
      <button
        type="button"
        onClick={() => bbox && fetchArea.mutate({ bbox })}
        disabled={fetchArea.isPending || working > 0}
        className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} bg-surface px-lg`}
      >
        {working > 0 ? (
          <>
            <span
              aria-hidden
              className="h-[6px] w-[6px] shrink-0 rounded-full bg-contour motion-safe:animate-pulse"
            />
            <span className="font-mono text-micro tabular-nums">
              {done} of {area.tiles} tiles
            </span>
          </>
        ) : (
          <span className="text-caption font-medium">
            {fetchArea.isPending ? 'Queueing…' : 'Fetch this area'}
          </span>
        )}
      </button>

      {working > 0 ? (
        <>
          {/*
            The bar is redundant by design — the count above already says everything it
            says. It exists because a number that changes every few seconds reads as static
            in peripheral vision while a filling bar does not, and this is a control the user
            glances at while doing something else. `aria-hidden` because the count is already
            the accessible answer and announcing both would be saying it twice.
          */}
          <div
            aria-hidden
            className="h-[3px] w-[168px] overflow-hidden rounded-hair border border-bezel bg-surface"
          >
            <div
              className="h-full bg-contour transition-[width] duration-slow ease-standard"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="sr-only" aria-live="polite">
            Fetching this area: {done} of {area.tiles} tiles complete.
          </p>
        </>
      ) : null}

      {busy && working === 0 ? (
        // Admission refused. Said plainly, because the alternative — a button that reports
        // success and then never makes anything appear — is the failure mode this message
        // exists to prevent. Which refusal decides the sentence: a queue drains, and storage
        // does not, so only one of them may end with "try again in a few minutes".
        <p
          role="status"
          className="max-w-[240px] rounded-panel border border-bezel bg-surface px-sm py-xs text-center text-micro tracking-normal text-ink-muted"
        >
          {busyReason === 'storage'
            ? 'There is no room left to store new ground. Trails already mapped still work.'
            : 'The fetch queue is full right now. Try again in a few minutes.'}
        </p>
      ) : null}

      {area.capped && working === 0 && !busy ? (
        // Honest about the cap rather than silently fetching the middle and letting the
        // edges look empty. `requiredTiles` is the whole box; `tiles` is what one press
        // takes. Kept to one short line: this sits over the map at rest, and a three-line
        // paragraph of caveat is more chrome than the caveat is worth.
        <p className="max-w-[260px] rounded-panel border border-bezel bg-surface px-sm py-xs text-center text-micro tracking-normal text-ink-muted">
          {area.requiredTiles} tiles in view · one fetch covers the nearest {area.tiles}
        </p>
      ) : null}
    </div>
  );
}
