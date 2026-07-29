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
 * The ring, at index scale.
 *
 * Thirty cards on screen and thirty copies of this component, all reading **one** query.
 * `lists.savedIds` answers "which trails has this person marked" for the whole account in a
 * single round trip, and react-query hands the same cached array to every card — including
 * cards for trails that stream in later from a tile that has only just landed, which is why
 * the card asks a shared question rather than being told the answer as a prop.
 *
 * **A set mark is filled; an unset one is an empty ring.** Both are always drawn. The ring
 * used to appear only on hover, which is a fine reading of "don't let thirty controls compete
 * with the thirty photographs they sit on" and a bad piece of engineering: hover is a mouse,
 * and on a phone the only way to favourite a trail from the index was to tap a transparent
 * square and hope. The competition it was avoiding is real, so the answer is weight rather
 * than absence — an unset ring is a hairline in muted ink, 24 px, and a set one is solid.
 * Filled, it has stopped being a control and become information.
 *
 * The optimistic write is not a flourish. This is a tap on a dense list where the eye is
 * already moving to the next row, and a mark that fills a beat later reads as a mis-tap.
 */

/**
 * The account's marks, shared.
 *
 * A hook rather than a prop so the card and its ring can both read it without the card
 * having to hold state it does not own. Signed out it never asks: the answer is empty and
 * the server would only say so again.
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
 * Shape and motion only — colour is the caller's, because colour is the state.
 *
 * `size-6` and then `HIT` on top of it, which is the pattern `controls.ts` documents and had
 * so far been used in exactly one of the three places it names. The mark is 24 px because at
 * 48 it stops annotating the card and starts covering it — thirty of them down an index would
 * be a column of buttons with photographs behind. But 24 px is a small thing to hit with a
 * thumb on a hillside, so the *mark* stays 24 and the *target* is the invisible centred 48 px
 * box `HIT` lays over it. `relative` was already here, which is the containing block that box
 * needs; without one it would centre on whichever ancestor happened to be positioned.
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
