'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SavedTrailIds } from '@switchback/core';
import { EMPTY_SAVED_IDS } from '@switchback/core';
import { askAgain } from '../../lib/after-write';
import { useTRPC } from '../../trpc/react';
import { HIT } from '../controls';
import { Mark } from './marks';

/**
 * The ring, at index scale. Thirty cards on screen read one `lists.savedIds` query, which is
 * why the card asks a shared question rather than being handed the answer as a prop — trails
 * stream in later from tiles that have only just landed.
 *
 * Both states are always drawn: a hover-only ring is a mouse, and on a phone the only way to
 * favourite from the index was to tap a transparent square and hope. Weight carries the state
 * instead — a hairline ring unset, solid set. The write is optimistic because a mark that
 * fills a beat later reads as a mis-tap.
 */

/**
 * The account's marks, shared. A hook rather than a prop so the card and its ring both read it
 * without the card holding state it does not own. Signed out it never asks.
 */
export function useSaved(viewerId: string | null): SavedTrailIds {
  const trpc = useTRPC();
  const saved = useQuery(
    trpc.lists.savedIds.queryOptions(undefined, { enabled: viewerId !== null }),
  );
  return saved.data ?? EMPTY_SAVED_IDS;
}

export interface SaveMarkProps {
  trailId: string;
  /** Named so a column of these does not announce as "Favourite, Favourite, Favourite". */
  trailName: string;
  ringed: boolean;
  viewerId: string | null;
}

/*
 * Shape and motion only — colour is the caller's, because colour is the state. The mark stays
 * 24 px (at 48 it covers the card it annotates) and `HIT` lays an invisible centred 48 px
 * target over it; `relative` is the containing block that box needs.
 */
const BASE = `relative z-10 flex size-6 shrink-0 items-center justify-center rounded-hair border transition-colors duration-quick ease-standard ${HIT}`;

export function SaveMark({ trailId, trailName, ringed, viewerId }: SaveMarkProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const toggle = useMutation(
    trpc.lists.toggle.mutationOptions({
      onMutate: () => {
        // Flip the shared cache now; every card holding this trail moves with it.
        queryClient.setQueryData(trpc.lists.savedIds.queryKey(), (previous) =>
          previous
            ? {
                ...previous,
                favorites: ringed
                  ? previous.favorites.filter((id) => id !== trailId)
                  : [...previous.favorites, trailId],
              }
            : previous,
        );
      },
      // Settled, not success: a failed toggle has to put the mark back where it was, and the
      // server's own answer is the only thing that knows where that is.
      onSettled: () => {
        void askAgain(queryClient, trpc.lists.pathFilter());
      },
    }),
  );

  if (viewerId === null) {
    return (
      <button
        type="button"
        // The viewport lives in the query string, so signing in from the index and landing
        // back on a different mountain is a real thing to avoid.
        onClick={() =>
          router.push(
            `/signin?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          )
        }
        className={`${BASE} border-bezel text-ink-muted hover:border-ink hover:text-ink`}
      >
        <Mark shape="ring" size={13} />
        <span className="sr-only">Sign in to keep {trailName}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={ringed}
      onClick={() => toggle.mutate({ trailId, kind: 'favorites' })}
      className={`${BASE} ${
        ringed
          ? 'border-ink bg-ink text-canvas'
          : 'border-bezel text-ink-muted hover:border-ink hover:text-ink'
      }`}
    >
      <Mark shape="ring" size={13} />
      <span className="sr-only">
        {ringed ? `${trailName} is one of your favourites` : `Favourite ${trailName}`}
      </span>
    </button>
  );
}
