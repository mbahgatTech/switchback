'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ListDetail } from '@switchback/core';
import { LIST_DESCRIPTION_MAX, LIST_NAME_MAX, isSystemList, plural } from '@switchback/core';
import { askAgain } from '../../lib/after-write';
import { useTRPC } from '../../trpc/react';
import { BUTTON_COLLAR, DANGER, GHOST, HEIGHT, PRIMARY, SECONDARY } from '../controls';

/**
 * Changing what a list is.
 *
 * Closed until asked for, because a list page is for looking at trails. Three fields, and
 * which of them appear depends on what kind of list it is: the three provisioned ones can be
 * described and published but not renamed or deleted, because "Favourites" is not a name the
 * person chose — it is what the ring on every trail page puts things into, and letting it
 * drift to something else points that control at a word nobody recognises.
 *
 * **Publishing is stated, not implied.** The toggle says who can read it in the same breath
 * as offering to change it. Someone keeping a list of hikes they can take their children on
 * has not asked to publish an itinerary, and a bare "Public" switch is how they find out
 * they did.
 */

export function ListSettings({ list }: { list: ListDetail }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const nameId = useId();
  const descriptionId = useId();

  const system = isSystemList(list.kind);

  function settle(): void {
    void askAgain(queryClient, trpc.lists.pathFilter());
    router.refresh();
  }

  const update = useMutation(
    trpc.lists.update.mutationOptions({
      onSuccess: (saved) => {
        setOpen(false);
        settle();
        // The slug is derived from the name, so a rename moves the page out from under us.
        if (saved.slug !== list.slug) router.replace(`/lists/${saved.slug}`);
      },
    }),
  );

  const remove = useMutation(
    trpc.lists.remove.mutationOptions({
      onSuccess: () => {
        settle();
        router.replace('/lists');
      },
    }),
  );

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-md">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
        >
          Edit list
        </button>
        <span className="collar">{list.isPublic ? 'Anyone with the link' : 'Only you'}</span>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({
          listId: list.id,
          ...(system ? {} : { name: name.trim() || list.name }),
          description: description.trim() || null,
        });
      }}
      className="rounded-hair border border-bezel bg-surface p-md sm:p-lg"
    >
      <fieldset disabled={update.isPending || remove.isPending} className="border-0 p-0">
        {system ? null : (
          <div>
            <label htmlFor={nameId} className="collar">
              Name
            </label>
            <input
              id={nameId}
              value={name}
              maxLength={LIST_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              className="mt-sm w-full rounded-hair border border-bezel bg-canvas px-sm py-xs text-body text-ink"
            />
          </div>
        )}

        <div className={system ? '' : 'mt-lg'}>
          <label htmlFor={descriptionId} className="collar">
            What is it for
          </label>
          <textarea
            id={descriptionId}
            value={description}
            maxLength={LIST_DESCRIPTION_MAX}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Somewhere to say why these belong together."
            className="mt-sm w-full rounded-hair border border-bezel bg-canvas px-sm py-sm font-text text-body leading-relaxed text-ink placeholder:text-ink-muted"
          />
        </div>

        {/*
         * A single control rather than a checkbox labelled "Public": the sentence says the
         * current state and the button says what pressing it will do, so nobody has to work
         * out which way a tick mark points.
         */}
        <p className="mt-lg flex flex-wrap items-center gap-sm text-caption text-ink-muted">
          {list.isPublic
            ? 'Anyone with the link can read this list.'
            : 'Only you can see this list.'}
          <button
            type="button"
            onClick={() => update.mutate({ listId: list.id, isPublic: !list.isPublic })}
            className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md`}
          >
            {list.isPublic ? 'Make it private' : 'Publish it'}
          </button>
        </p>

        <div className="mt-lg flex flex-wrap items-center gap-sm border-t border-bezel pt-md">
          <button type="submit" className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.panel} px-lg`}>
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setConfirmingDelete(false);
              setName(list.name);
              setDescription(list.description ?? '');
            }}
            className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
          >
            Cancel
          </button>

          {system ? null : (
            <div className="ml-auto flex items-center gap-sm">
              {confirmingDelete ? (
                <>
                  <span className="text-caption text-ink-muted">
                    Delete “{list.name}” and its {list.trailCount}{' '}
                    {plural(list.trailCount, 'trail')}?
                  </span>
                  <button
                    type="button"
                    onClick={() => remove.mutate({ listId: list.id })}
                    className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
                  >
                    {remove.isPending ? 'Deleting…' : 'Delete it'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-md`}
                >
                  Delete list
                </button>
              )}
            </div>
          )}
        </div>

        {update.isError || remove.isError ? (
          <p className="mt-md text-caption text-survey">
            {update.error?.message ?? remove.error?.message ?? 'That did not save. Try again.'}
          </p>
        ) : null}
      </fieldset>
    </form>
  );
}
