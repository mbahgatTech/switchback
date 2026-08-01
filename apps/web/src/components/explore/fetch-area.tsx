'use client';

import { useMutation } from '@tanstack/react-query';
import type { AreaSummary, BBox } from '@switchback/core';
import { useTRPC } from '@/trpc/react';
import { BUTTON, HEIGHT, SECONDARY } from '../controls';

/**
 * Fetch this area — the one control that asks the pipeline for ground it has never seen.
 *
 * Automatic ingest caps at twelve z9 tiles, so this button appears only past that ceiling with
 * ground still outstanding; at every ordinary zoom the map is already filling itself. Progress
 * is in tiles rather than minutes, because an Overpass round trip is two seconds or a
 * timeout-and-retry. The `bg-surface` fill is the only difference from the same button in a
 * panel, and it is there because everything floating over the map is opaque.
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
   * Percentage of the *capped* set, which is the set this press can finish. `requiredTiles`
   * would show a bar stopping at 12% on a continental view and never moving.
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
        // Admission refused, said plainly. Which refusal decides the sentence: a queue drains
        // and storage does not, so only one of them may end with "try again in a few minutes".
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
        // Honest about the cap rather than silently fetching the middle and letting the edges
        // look empty. `requiredTiles` is the whole box; `tiles` is what one press takes.
        <p className="max-w-[260px] rounded-panel border border-bezel bg-surface px-sm py-xs text-center text-micro tracking-normal text-ink-muted">
          {area.requiredTiles} tiles in view · one fetch covers the nearest {area.tiles}
        </p>
      ) : null}
    </div>
  );
}
