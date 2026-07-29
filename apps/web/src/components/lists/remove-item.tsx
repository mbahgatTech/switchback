'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { askAgain } from '../../lib/after-write';
import { useTRPC } from '../../trpc/react';
import { BUTTON_COLLAR, DANGER, GHOST, HEIGHT } from '../controls';

/**
 * Taking one row back out.
 *
 * It used to be hidden until the row was hovered or the control focused, on the reasoning
 * that a destructive control permanently visible on every row of a long list gets pressed by
 * accident. The reasoning holds for a mouse and is worthless on a phone, where there is no
 * hover and the control therefore did not exist at all — a list you can add to and cannot
 * edit. So it is always there, and the accident it was hiding from is answered the way the
 * rest of the app answers it: quietly. Ghost lettering, no border, the least emphatic thing
 * in the row, next to a trail name and a photograph that are the reasons the row is there.
 *
 * One tap, no confirmation. Putting a trail back in a list is one tap from the trail page,
 * so an "are you sure" here guards against nothing — unlike forgetting a hike, which is a
 * dated fact the person would have to remember to reconstruct.
 */

export interface RemoveItemProps {
  listId: string;
  trailId: string;
  /** Set on a completed list: this row is one dated hike, not a membership. */
  completionId: string | null;
  /** Named so the announcement is not "Remove, Remove, Remove" down the column. */
  trailName: string;
}

export function RemoveItem({ listId, trailId, completionId, trailName }: RemoveItemProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  function settle(): void {
    void askAgain(queryClient, trpc.lists.pathFilter());
    // The page is server rendered from `lists.detail`; without this the row stays.
    router.refresh();
  }

  const removeTrail = useMutation(trpc.lists.removeTrail.mutationOptions({ onSuccess: settle }));
  const forget = useMutation(trpc.lists.forgetCompletion.mutationOptions({ onSuccess: settle }));

  const pending = removeTrail.isPending || forget.isPending;

  // A hike is a dated fact rather than a filing decision, so that one asks.
  if (completionId !== null && confirming) {
    return (
      <span className="relative z-10 flex shrink-0 items-center gap-xs">
        <button
          type="button"
          disabled={pending}
          onClick={() => forget.mutate({ completionId })}
          className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-sm`}
        >
          {pending ? 'Forgetting…' : 'Forget it'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
        >
          Keep
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        completionId !== null ? setConfirming(true) : removeTrail.mutate({ listId, trailId })
      }
      // Above the card's link overlay, or the overlay swallows it. Not hover-revealed: a
      // list is edited from a phone at least as often as from a mouse, and a control that
      // only appears under a cursor is a control half the readers do not have.
      className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} relative z-10 shrink-0 px-sm`}
    >
      {completionId !== null ? 'Forget' : 'Remove'}
      <span className="sr-only"> {trailName}</span>
    </button>
  );
}
