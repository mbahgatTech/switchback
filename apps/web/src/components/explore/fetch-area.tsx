'use client';

import { useMutation } from '@tanstack/react-query';
import type { AreaSummary, BBox } from '@switchback/core';
import { useTRPC } from '@/trpc/react';
import { BUTTON, HEIGHT, SECONDARY } from '../controls';
import { fetchAreaView } from './fetch-area-state';

/**
 * Fetch this area — the one control that asks the pipeline for ground it has never seen.
 *
 * Automatic ingest caps at twelve z9 tiles, so this button appears only past that ceiling with
 * ground still outstanding; at every ordinary zoom the map is already filling itself. Progress
 * is in tiles rather than minutes, because an Overpass round trip is two seconds or a
 * timeout-and-retry. What each state *says* is decided in `fetch-area-state.ts`, where it can be
 * tested without a DOM; this file is the markup for that decision and nothing else.
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

  const view = fetchAreaView({
    area,
    hasBBox: bbox !== null,
    press: {
      pending: fetchArea.isPending,
      // Without this the whole of `fetchArea`'s failure surface — a 500, a dropped connection,
      // an offline click — rendered exactly like never having pressed the button at all.
      failed: fetchArea.isError,
      result: fetchArea.data ?? null,
    },
  });
  if (!view || !bbox) return null;

  // A refusal and a failure are answers to the press; the other two are standing context, and
  // progress is already announced by the live region below.
  const announced = view.message?.tone === 'failure' || view.message?.tone === 'refusal';

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-xs">
      <button
        type="button"
        onClick={() => fetchArea.mutate({ bbox })}
        disabled={view.disabled}
        className={`${BUTTON} ${SECONDARY} ${HEIGHT.touch} bg-surface px-lg`}
      >
        {view.progress ? (
          <>
            <span
              aria-hidden
              className="h-[6px] w-[6px] shrink-0 rounded-full bg-contour motion-safe:animate-pulse"
            />
            <span className="font-mono text-micro tabular-nums">{view.label}</span>
          </>
        ) : (
          <span className="text-caption font-medium">{view.label}</span>
        )}
      </button>

      {view.progress ? (
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
              style={{ width: `${view.progress.percent}%` }}
            />
          </div>
          <p className="sr-only" aria-live="polite">
            {view.liveText}
          </p>
        </>
      ) : null}

      {view.message ? (
        <p
          role={announced ? 'status' : undefined}
          className="max-w-[240px] rounded-panel border border-bezel bg-surface px-sm py-xs text-center text-micro tracking-normal text-ink-muted"
        >
          {view.message.text}
        </p>
      ) : null}
    </div>
  );
}
